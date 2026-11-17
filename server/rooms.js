'use strict';
// Rooms, participants, rate limiting, session lifecycle. One process, in-memory (blueprint 10.1).
const crypto = require('crypto');
const T = require('./theory');
const { Conductor, ROLES, QUOTAS, assignRoleList, roleCounts } = require('./conductor');
const { validateGesture } = require('./protocol');

const ADJ = ['Bright', 'Swift', 'Calm', 'Bold', 'Merry', 'Jolly', 'Lucky', 'Sunny', 'Quiet', 'Wild', 'Cosmic', 'Gentle'];
const NOUN = ['Otter', 'Falcon', 'Panda', 'Comet', 'Maple', 'Tiger', 'Pixel', 'Koala', 'Echo', 'Fox', 'Lynx', 'Wave'];
const COST = { tap: 1, shake: 2, hold_start: 1, hold_update: 0.25, hold_end: 0.25, tilt: 0.25 };
const TTL_MS = 30 * 60 * 1000, HEARTBEAT_MS = 15000, MAX_EVENTS = 10000;
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const token = () => crypto.randomBytes(18).toString('hex');
const send = (ws, m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };

class Room {
  constructor({ preset = 'RADIANT', timeScale = 1, maxParticipants = 30 } = {}) {
    this.id = 'room_' + crypto.randomBytes(5).toString('hex');
    this.code = Array.from({ length: 4 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ'[crypto.randomInt(23)]).join('');
    this.hostToken = token(); this.hostTokenHash = hash(this.hostToken);
    this.status = 'LOBBY'; this.createdAt = Date.now(); this.expiresAt = this.createdAt + TTL_MS;
    this.timeScale = timeScale; this.maxParticipants = maxParticipants;
    this.seed = crypto.randomInt(1, 2 ** 31); this.config = T.makeConfig(preset, this.seed);
    this.participants = new Map(); this.byToken = new Map(); this.eventLog = []; this.nextSeq = 1;
    this.conductor = null; this.hostWs = null; this.pausedAt = null; this.lastBar = -1; this.slotCounter = 0;
  }
  touch() { this.expiresAt = Date.now() + TTL_MS; }
  connected() { return [...this.participants.values()].filter((p) => p.connected); }

  // ---- membership
  join() {
    if (this.status === 'COMPLETE' || this.status === 'FINALIZING') { const e = new Error('closed'); e.code = 410; throw e; }
    if (this.participants.size >= this.maxParticipants) { const e = new Error('full'); e.code = 409; throw e; }
    const tok = token(), id = 'p_' + crypto.randomBytes(4).toString('hex');
    const p = { id, tokenHash: hash(tok), alias: `${ADJ[crypto.randomInt(ADJ.length)]} ${NOUN[crypto.randomInt(NOUN.length)]}`, connected: false, joinedAt: Date.now(),
      lastSeenAt: Date.now(), role: 'PERCUSSION', roleAssignedAtBar: 0, lastInputAt: 0, lastClientSequence: -1, ws: null, slot: this.slotCounter++,
      tokens: 4, refilledAt: Date.now(), window: [], lastTapAt: 0, lastShakeAt: 0, lastHoldAt: 0, accepted: 0 };
    this.participants.set(id, p); this.byToken.set(p.tokenHash, p);
    this.assignNew(p); this.touch();
    return { p, token: tok };
  }
  authParticipant(tok) { return this.byToken.get(hash(tok)); }
  authHost(tok) { return typeof tok === 'string' && crypto.timingSafeEqual(Buffer.from(hash(tok)), Buffer.from(this.hostTokenHash)); }

  // Role assignment: quotas by round, largest-remainder rounding, rotation each round (12.4)
  assignNew(p) {
    const round = this.conductor ? this.conductor.round : 'RHYTHM', n = this.connected().length + 1;
    const counts = roleCounts(n, QUOTAS[round]), have = {};
    this.connected().forEach((x) => { have[x.role] = (have[x.role] || 0) + 1; });
    p.role = ROLES.map((r) => ({ r, d: counts[r] - (have[r] || 0) })).sort((a, b) => b.d - a.d)[0].r;
  }
  assignRoles(round, idx) {
    const list = this.connected().sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
    const roles = assignRoleList(list.length, round, idx);
    list.forEach((p, i) => { p.role = roles[i]; p.roleAssignedAtBar = this.conductor ? this.conductor.plannedBar + 1 : 0; });
    list.forEach((p) => this.sendState(p));
  }
  roleCounts() { const c = Object.fromEntries(ROLES.map((r) => [r, 0])); this.connected().forEach((p) => c[p.role]++); return c; }

  // ---- sockets
  attachHost(ws) { this.hostWs = ws; send(ws, this.hostState('snapshot')); }
  attachParticipant(p, ws) {
    if (p.ws && p.ws !== ws) try { p.ws.close(); } catch {}
    p.ws = ws; p.connected = true; p.lastSeenAt = Date.now();
    send(ws, this.participantState(p, 'snapshot')); this.pushHost('participants');
  }
  detachParticipant(p, ws) { if (p.ws === ws) { p.connected = false; p.ws = null; this.pushHost('participants'); } }
  pushHost(why) { send(this.hostWs, this.hostState('state_update', why)); }

  participantState(p, type = 'state_update') {
    const c = this.conductor, ch = c ? c.chordForBar(Math.max(0, c.barAt(Date.now()))) : null;
    return { type, roomId: this.id, status: this.status, round: c ? c.round : 'RHYTHM', role: p.role, alias: p.alias, tempoBpm: this.config.tempoBpm,
      key: T.NOTE_NAMES[T.mod12(this.config.keyRootMidi)], scale: this.config.scale, chord: ch ? ch.sym : null, bar: c ? Math.max(0, c.barAt(Date.now())) : 0,
      beat: 1, serverTimeMs: Date.now(), nextBarAtServerMs: c && c.epochMs ? c.msOfBeat((Math.max(0, c.barAt(Date.now())) + 1) * 4) : null,
      densityTarget: c ? c.density : 0.3, energy: c ? c.energy : 0 };
  }
  sendState(p) { send(p.ws, this.participantState(p)); }
  hostState(type, why) {
    const c = this.conductor, now = Date.now(), bar = c && c.epochMs ? Math.max(0, c.barAt(now)) : 0, ch = c ? c.chordForBar(bar) : null;
    return { type, why, roomId: this.id, code: this.code, status: this.status, preset: this.config.preset, round: c ? c.round : 'RHYTHM', tempoBpm: this.config.tempoBpm,
      key: T.NOTE_NAMES[T.mod12(this.config.keyRootMidi)] + (this.config.scale === 'MINOR' ? ' minor' : ' major'), chord: ch ? ch.sym : null, bar,
      beat: c && c.epochMs ? Math.floor(((c.absNow(now) % 4) + 4) % 4) + 1 : 1, epochServerMs: c ? c.epochMs : null, serverTimeMs: now,
      participants: this.connected().length, roles: this.roleCounts(), densityTarget: c ? c.density : 0, energy: c ? c.energy : 0, activity: c ? c.activity : 0, seed: this.seed };
  }

  // ---- lifecycle
  start(preset) {
    if (this.status !== 'LOBBY') return false;
    if (preset && T.PRESETS[preset]) this.config = T.makeConfig(preset, this.seed);
    this.conductor = new Conductor(this.config, {
      assignRoles: (r, i) => { this.assignRoles(r, i); },
      connectedCount: () => this.connected().length,
      onEnding: () => { this.status = 'FINALIZING'; this.pushHost('ending'); this.connected().forEach((p) => this.sendState(p)); },
    }, { timeScale: this.timeScale });
    this.status = 'RUNNING'; this.conductor.start(Date.now());
    this.assignRoles('RHYTHM', 0); this.pushHost('started'); this.touch(); return true;
  }
  pause() { if (this.status !== 'RUNNING') return false; this.status = 'PAUSED'; this.pausedAt = Date.now(); this.conductor.queue = []; this.broadcast(); return true; }
  resume() {
    if (this.status !== 'PAUSED') return false;
    this.conductor.shiftEpoch(Date.now() - this.pausedAt); this.conductor.plannedBar = Math.max(this.conductor.plannedBar, this.conductor.barAt(Date.now()));
    this.status = 'RUNNING'; this.pausedAt = null; this.broadcast(); return true;
  }
  end() { if (this.status !== 'RUNNING' && this.status !== 'PAUSED') return false; if (this.status === 'PAUSED') this.resume(); this.conductor.requestEnd(); return true; }
  advance() { if (this.status !== 'RUNNING') return false; this.conductor.advanceRound(); return true; }
  broadcast() { this.pushHost('status'); this.connected().forEach((p) => this.sendState(p)); }

  // ---- gesture pipeline: validate -> rate-limit -> dedupe -> interpret -> ack
  handleGesture(p, raw, now = Date.now()) {
    const g = validateGesture(raw);
    if (!g) return { type: 'gesture_ack', clientSequence: raw && Number.isSafeInteger(raw.clientSequence) ? raw.clientSequence : null, accepted: false, reason: 'BAD_SCHEMA', eventId: null };
    const ack = (accepted, reason = null, eventId = null) => ({ type: 'gesture_ack', clientSequence: g.clientSequence, accepted, reason, eventId });
    if (this.status === 'COMPLETE' || this.status === 'FINALIZING') return ack(false, 'ROOM_CLOSED');
    if (this.status !== 'RUNNING') return ack(false, 'NOT_RUNNING');
    if (g.clientSequence === p.lastClientSequence) return ack(false, 'DUPLICATE');
    if (g.clientSequence < p.lastClientSequence) return ack(false, 'STALE_SEQUENCE');
    p.lastClientSequence = g.clientSequence;
    if (g.inputId === 'tap' && now - p.lastTapAt < 120) return ack(false, 'DUPLICATE');
    if (g.inputId === 'shake' && now - p.lastShakeAt < 450) return ack(false, 'DUPLICATE');
    if (g.inputId === 'hold_update' && now - p.lastHoldAt < 200) return ack(false, 'RATE_LIMITED');
    p.tokens = Math.min(4, p.tokens + ((now - p.refilledAt) / 1000) * 2); p.refilledAt = now;        // bucket: 4 cap, 2/s
    p.window = p.window.filter((t) => now - t < 2000);
    const cost = COST[g.inputId];
    if (p.tokens < cost || p.window.length >= 8) return ack(false, 'RATE_LIMITED');
    p.tokens -= cost; p.window.push(now); p.lastInputAt = now; p.accepted++;
    if (g.inputId === 'tap') p.lastTapAt = now; if (g.inputId === 'shake') p.lastShakeAt = now; if (g.inputId === 'hold_update') p.lastHoldAt = now;
    const evs = this.conductor.gesture(p, g, now);
    return ack(true, null, evs.length ? evs[0].eventId : null);
  }

  // ---- 25 Hz server tick
  tick(now = Date.now()) {
    if (this.status === 'LOBBY' || this.status === 'PAUSED' || this.status === 'COMPLETE') { this.sweep(now); return; }
    const r = this.conductor.tick(now);
    for (const e of r.events) {
      e.sequence = this.nextSeq++; e.roomId = this.id; e.createdAtServerMs = now;
      this.eventLog.push(e); if (this.eventLog.length > MAX_EVENTS) this.eventLog.shift();
      send(this.hostWs, { type: 'musical_event', event: e });
    }
    if (r.newBars.length || r.roundChanged) { this.pushHost('bar'); if (r.roundChanged) this.connected().forEach((p) => this.sendState(p)); }
    if (r.finished) { this.status = 'COMPLETE'; this.broadcast(); }
    this.sweep(now);
  }
  sweep(now) { for (const p of this.participants.values()) if (p.connected && now - p.lastSeenAt > HEARTBEAT_MS) { try { p.ws.terminate(); } catch {} p.connected = false; p.ws = null; } }
  exportData() {
    const c = this.conductor;
    return { metadata: { title: 'CrowdSynth - Session ' + this.code, seed: this.seed, tempoBpm: this.config.tempoBpm, key: this.hostState('x').key, preset: this.config.preset,
      scale: this.config.scale, keyRootMidi: this.config.keyRootMidi, participantCount: this.participants.size, eventCount: this.eventLog.length,
      epochServerMs: c ? c.epochMs : null, endBar: c ? c.endBar : null, rendererVersion: '0.1.0' }, config: this.config, events: this.eventLog };
  }
}

class RoomManager {
  constructor(opts = {}) { this.rooms = new Map(); this.opts = opts; }
  create(preset) {
    for (const [k, r] of this.rooms) if (Date.now() > r.expiresAt || this.rooms.size > 50) this.rooms.delete(k);
    const r = new Room({ preset, ...this.opts }); this.rooms.set(r.id, r); return r;
  }
  byId(id) { return this.rooms.get(id); }
  byCode(code) { for (const r of this.rooms.values()) if (r.code === String(code).toUpperCase()) return r; }
  tick() { for (const r of this.rooms.values()) r.tick(); }
}

module.exports = { Room, RoomManager, send };
