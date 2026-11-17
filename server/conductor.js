'use strict';
// The music brain. Time is measured in absolute beats from the session epoch; the host maps that to its audio clock.
// Participants send gestures -> intents -> constrained musical events (scale, chord, grid, budgets). Autonomous
// events use exactly the same constraints and the same budget gate.
const T = require('./theory');
const { clamp } = T;

const ROLES = ['PULSE', 'PERCUSSION', 'BASS', 'HARMONY', 'MELODY', 'TEXTURE'];
const ROUNDS = ['RHYTHM', 'FOUNDATION', 'MELODY', 'CLIMAX'];
const QUOTAS = {
  RHYTHM:     { PULSE: 0.35, PERCUSSION: 0.45, BASS: 0.05, HARMONY: 0.05, MELODY: 0, TEXTURE: 0.10 },
  FOUNDATION: { PULSE: 0.10, PERCUSSION: 0.15, BASS: 0.25, HARMONY: 0.30, MELODY: 0.05, TEXTURE: 0.15 },
  MELODY:     { PULSE: 0.05, PERCUSSION: 0.10, BASS: 0.10, HARMONY: 0.15, MELODY: 0.45, TEXTURE: 0.15 },
  CLIMAX:     { PULSE: 0.20, PERCUSSION: 0.25, BASS: 0.15, HARMONY: 0.15, MELODY: 0.15, TEXTURE: 0.10 },
};
const EXPECTED = { RHYTHM: ['PULSE', 'PERCUSSION'], FOUNDATION: ['BASS', 'HARMONY'], MELODY: ['MELODY', 'TEXTURE'], CLIMAX: ROLES };
const TIMING = { RHYTHM: { min: 15, max: 25, thr: 0.3 }, FOUNDATION: { min: 20, max: 30, thr: 0.35 },
  MELODY: { min: 20, max: 30, thr: 0.4 }, CLIMAX: { min: 15, max: 25, thr: 0.5 } }; // seconds
const L = { MIN_LEAD_MS: 250, FLUSH_LEAD_MS: 150, PLAN_AHEAD_MS: 900, BAR_EVENTS: 24, VOICES: 8, DRUMS_BEAT: 6, MELODY_BEAT: 2, BASS_BEAT: 1, TAIL_MS: 3000 };
const WEIGHT = { BASS: 1, HARMONY: 0.9, PULSE: 0.9, MELODY: 0.8, PERCUSSION: 0.7, TEXTURE: 0.5 };
const PAN = { PULSE: 0, PERCUSSION: 0.3, BASS: 0, HARMONY: -0.25, MELODY: 0.15, TEXTURE: 0.4 };
const DRUMS = new Set(['KICK', 'SNARE', 'CLAP', 'SHAKER']);
const BASSES = new Set(['SUB_BASS', 'PLUCK_BASS']);
const LEADS = new Set(['SYNTH_LEAD', 'FLUTE', 'MARIMBA']);

// Largest-remainder rounding so quotas always sum to n.
function roleCounts(n, quotas) {
  const rows = ROLES.map((r, i) => { const x = quotas[r] * n + 1e-9; return { r, i, base: Math.floor(x), rem: x - Math.floor(x) }; });
  let left = n - rows.reduce((s, x) => s + x.base, 0);
  [...rows].sort((a, b) => b.rem - a.rem || a.i - b.i).slice(0, Math.max(0, left)).forEach((x) => x.base++);
  return Object.fromEntries(rows.map((x) => [x.r, x.base]));
}
function assignRoleList(n, round, roundIdx) {
  const counts = roleCounts(n, QUOTAS[round]);
  const slots = ROLES.flatMap((r) => Array(counts[r]).fill(r));
  const k = slots.length ? roundIdx % slots.length : 0; // rotate each round so early joiners don't always get the same role
  return slots.slice(k).concat(slots.slice(0, k));
}

class Conductor {
  constructor(cfg, hooks = {}, opts = {}) {
    this.cfg = cfg; this.P = T.PRESETS[cfg.preset]; this.key = cfg.keyRootMidi; this.scale = cfg.scale; this.bpm = cfg.tempoBpm;
    this.hooks = hooks; this.ts = opts.timeScale || 1;
    this.beatMs = 60000 / this.bpm; this.barMs = this.beatMs * 4;
    this.epochMs = null; this.plannedBar = -1; this.round = 'RHYTHM'; this.roundIdx = 0; this.roundStartBar = 0;
    this.endRequested = false; this.endBar = null; this.forceAdvance = false; this.finished = false;
    this.queue = []; this.recent = []; this.energy = 0; this.density = 0.3; this.activity = 0; this.padLevel = 0; this.pulseLevel = 0;
    this.evCounter = 0; this.rngCounter = 0; this.melody = { last: null, step: 0, dir: 1 };
    this.lastHarm = 64; this.lastVoicing = null; this.voiceBias = 0; this.texShift = 0; this.percToggle = 0;
    this.barCount = new Map(); this.beatCount = new Map(); this.voices = []; this.dropped = 0; this.lastTick = null; this.lastBarSeen = -1;
  }
  rnd() { return T.rand(this.cfg.seed, this.rngCounter++); }
  start(nowMs) { this.epochMs = nowMs + 1500; this.lastTick = nowMs; }
  absNow(ms) { return (ms - this.epochMs) / this.beatMs; }
  msOfBeat(abs) { return this.epochMs + abs * this.beatMs; }
  barAt(ms) { return Math.floor((ms - this.epochMs) / this.barMs); }
  shiftEpoch(deltaMs) { this.epochMs += deltaMs; }
  chordForBar(b) {
    b = Math.max(0, b);
    if (this.endBar !== null && b >= this.endBar) return T.chordInfo(this.key, this.P.cad[Math.min(b - this.endBar, 1)]);
    return T.chordInfo(this.key, this.P.prog[Math.floor(b / this.P.bpc) % this.P.prog.length]);
  }
  bassRoot(ch) { let r = ch.rootMidi; while (r > 47) r -= 12; while (r < 36) r += 12; return r; }
  requestEnd() { this.endRequested = true; }
  advanceRound() { this.forceAdvance = true; }
  recentRoles(nowMs, windowMs) { return new Set(this.recent.filter((r) => nowMs - r.t <= windowMs).map((r) => r.role)); }

  // ---- adaptive density (14.6)
  updateDensity(nowMs) {
    const dt = Math.max(0, nowMs - (this.lastTick ?? nowMs)); this.lastTick = nowMs;
    this.energy *= Math.pow(0.5, dt / 6000);
    this.recent = this.recent.filter((r) => nowMs - r.t <= 20000);
    const last8 = this.recent.filter((r) => nowMs - r.t <= 8000);
    const n = Math.max(1, this.hooks.connectedCount ? this.hooks.connectedCount() : 0);
    this.activity = clamp(last8.length / (n * 4), 0, 1);
    const exp = EXPECTED[this.round], active = new Set(last8.map((r) => r.role));
    const coverage = exp.filter((r) => active.has(r)).length / exp.length;
    this.density = clamp(0.2 + 0.35 * this.activity + 0.25 * coverage + 0.2 * this.energy, 0.15, 0.85);
  }

  // ---- event construction + budget gate
  mk(source, role, instrument, kind, o) {
    const id = ++this.evCounter;
    return { eventId: 'evt_' + id, sequence: null, source, role, kind, instrument, pitchMidi: o.pitch, velocity: clamp(o.vel ?? 0.6, 0.05, 1),
      durationBeats: o.dur ?? 0.5, targetBar: Math.floor(o.abs / 4), targetBeat: (o.abs % 4) + 1, subdivision: o.sub ?? 1,
      pan: clamp((PAN[role] ?? 0) + (o.panJ ?? 0), -1, 1), articulation: o.art, _abs: o.abs, _pri: o.pri ?? 1 };
  }
  push(e) { this.queue.push(e); return e; }
  priority(role, rel, conf, abs, source) {
    const same = this.queue.filter((q) => q.role === role && q._abs === abs).length;
    return WEIGHT[role] * conf * rel * Math.pow(0.8, same) * (source === 'AUTONOMOUS' ? 0.6 : 1);
  }
  auto(role, instrument, o) { const e = this.mk('AUTONOMOUS', role, instrument, o.kind || 'NOTE', { ...o, pri: o.pri ?? this.priority(role, 1, 1, o.abs, 'AUTONOMOUS') }); return this.push(e); }

  kindOf(e) { return DRUMS.has(e.instrument) ? 'drum' : BASSES.has(e.instrument) ? 'bass' : LEADS.has(e.instrument) ? 'melody' : 'other'; }
  admit(e) {
    if (e.kind === 'CONTROL') return true;
    const bar = Math.floor(e._abs / 4), beat = Math.floor(e._abs), pitched = !DRUMS.has(e.instrument);
    if (e._pri >= 900) { this.count(e, bar, beat, pitched); return true; }       // cadence events are never dropped
    if ((this.barCount.get(bar) || 0) >= L.BAR_EVENTS) return false;
    const k = this.kindOf(e), cap = { drum: L.DRUMS_BEAT, bass: L.BASS_BEAT, melody: L.MELODY_BEAT }[k];
    if (cap && (this.beatCount.get(beat + '|' + k) || 0) >= cap) return false;
    if (pitched && this.voices.filter((v) => v.s <= e._abs && e._abs < v.e).length >= L.VOICES) return false;
    this.count(e, bar, beat, pitched); return true;
  }
  count(e, bar, beat, pitched) {
    this.barCount.set(bar, (this.barCount.get(bar) || 0) + 1);
    const k = this.kindOf(e); this.beatCount.set(beat + '|' + k, (this.beatCount.get(beat + '|' + k) || 0) + 1);
    if (pitched) { this.voices.push({ s: e._abs, e: e._abs + Math.max(0.25, e.durationBeats) }); if (this.voices.length > 64) this.voices.shift(); }
  }
  flush(nowMs) {
    const due = [], keep = [];
    for (const e of this.queue) (this.msOfBeat(e._abs) - nowMs <= L.FLUSH_LEAD_MS ? due : keep).push(e);
    this.queue = keep;
    if (!due.length) return [];
    const merged = new Map();       // identical hits from several people on one slot become ONE louder event (14.5)
    for (const e of due) {
      const key = e.kind === 'CONTROL' ? 'c' + e.instrument + e._abs : `${e.instrument}|${e.pitchMidi}|${e._abs}`, m = merged.get(key);
      if (m && e.kind !== 'CONTROL') { m.velocity = Math.min(1, Math.hypot(m.velocity, e.velocity)); m.contributors = (m.contributors || 1) + 1; m._pri = Math.max(m._pri, e._pri); m.durationBeats = Math.max(m.durationBeats, e.durationBeats); }
      else merged.set(key, e);
    }
    const out = [];
    for (const e of [...merged.values()].sort((a, b) => b._pri - a._pri || a._abs - b._abs)) (this.admit(e) ? out : { push: () => this.dropped++ }).push(e);
    return out.sort((a, b) => a._abs - b._abs).map((e) => { const c = {}; for (const k in e) if (k[0] !== '_') c[k] = e[k]; return c; });
  }

  // ---- melody voice leading (13.7/13.8)
  melodyNext(abs, ch, dirOverride) {
    const lo = this.key + 5, hi = this.key + 24;
    const cands = T.scalePitches(this.key, this.scale, lo, hi, this.P.melodyPent ? 'PENTATONIC' : null);
    const m = this.melody; if (dirOverride) m.dir = dirOverride;
    if (m.step > 0 && m.step % 8 === 0 && !dirOverride) m.dir = -m.dir; // new phrase, new contour
    const prev = m.last ?? this.key + 12, strong = [0, 2].includes(Math.floor(abs % 4)), leap = this.rnd() < 1 / 8;
    const nextCh = this.chordForBar(Math.floor(abs / 4) + 1), phraseEnd = m.step % 4 === 3;
    let best = null;
    for (const p of cands) {
      let s = T.melodyScore(p, prev, ch, m.dir, lo, hi, strong, leap) + this.rnd() * 0.01;
      if (phraseEnd && [nextCh.pcs[0], nextCh.pcs[1]].includes(T.mod12(p))) s += 1.5; // approach root/third of the next chord
      if (!best || s > best.s) best = { p, s };
    }
    m.last = best.p; m.step++;
    return best.p;
  }
  harmTone(ch) {
    const c = T.scalePitches(this.key, this.scale, 55, 79).filter((p) => ch.pcs.includes(T.mod12(p)) && p !== this.lastHarm); // never repeat the same note
    const p = c.reduce((a, b) => (Math.abs(b - this.lastHarm) + this.rnd() * 0.1 < Math.abs(a - this.lastHarm) ? b : a));
    this.lastHarm = p; return p;
  }
  textureTone(ch) {
    const c = T.scalePitches(this.key, this.scale, 72, 88, this.P.melodyPent ? 'PENTATONIC' : null);
    const p = T.weightedPick(c, c.map((x) => T.chordWeight(x, ch)), this.rnd()) + this.texShift;
    return T.inScale(p, this.key, this.scale) ? p : p - this.texShift;
  }

  // ---- gestures -> intents -> events (12.3, 12.6)
  gesture(p, g, nowMs) {
    const role = p.role, v = clamp(g.value ?? 0.6, 0, 1), rel = EXPECTED[this.round].includes(role) ? 1 : 0.6;
    const vel = (base) => clamp(base * (0.6 + 0.4 * rel) * (0.55 + 0.45 * v), 0.1, 1);
    const now = this.absNow(nowMs) + L.MIN_LEAD_MS / this.beatMs;
    const q = (sub) => T.quantizeBeat(now, sub), chordAt = (abs) => this.chordForBar(Math.floor(abs / 4));
    const out = [], jit = ((p.slot ?? 0) % 5 - 2) * 0.04;
    const add = (inst, o) => { const e = this.mk('PARTICIPANT', role, inst, o.kind || 'NOTE', { panJ: jit, ...o, pri: this.priority(role, rel, o.conf ?? 1, o.abs, 'PARTICIPANT') }); e._pid = p.id; out.push(this.push(e)); };
    this.recent.push({ t: nowMs, role }); this.energy = Math.min(1, this.energy + 0.08 * (0.4 + v));
    const id = g.inputId, hold = clamp((g.durationMs ?? 0) / 2000, 0, 1);

    if (id === 'tap') {
      if (role === 'PULSE') add('KICK', { abs: q(2), vel: vel(0.95), dur: 0.25, sub: 2 });
      else if (role === 'PERCUSSION') { const clap = this.percToggle++ % 2 === 0; add(clap ? 'CLAP' : 'SHAKER', { abs: q(4), vel: vel(clap ? 0.75 : 0.55), dur: 0.25, sub: 4 }); }
      else if (role === 'BASS') {
        const abs = q(1), ch = chordAt(abs), r = this.bassRoot(ch), idx = Math.floor(abs % 4);
        const pitch = idx === 2 ? r + 7 : idx === 3 && r + 12 <= 52 && this.energy > 0.5 ? r + 12 : r;
        add(this.P.bass, { abs, pitch, vel: vel(0.8), dur: 1, sub: 1 });
      } else if (role === 'HARMONY') { const abs = q(2); add('SOFT_KEYS', { abs, pitch: this.harmTone(chordAt(abs)), vel: vel(0.6), dur: 1.5, sub: 2 }); }
      else if (role === 'MELODY') { const abs = q(2); add(this.P.lead, { abs, pitch: this.melodyNext(abs, chordAt(abs)), vel: vel(0.75), dur: 0.75, sub: 2 }); }
      else { const abs = q(2); add('BELL', { abs, pitch: this.textureTone(chordAt(abs)), vel: vel(0.5), dur: 1, sub: 2 }); }
    } else if (id === 'hold_end') {
      if (role === 'PULSE') { this.pulseLevel = Math.min(1, this.pulseLevel + 0.3 + 0.4 * hold); const a = q(2); for (let i = 0; i < 4; i++) add('SHAKER', { abs: a + i * 0.5, vel: vel(0.45), dur: 0.25, sub: 2 }); }
      else if (role === 'PERCUSSION') { const a = q(4); for (let i = 0; i < 4; i++) add('SHAKER', { abs: a + i * 0.25, vel: vel(0.35), dur: 0.2, sub: 4 }); }
      else if (role === 'BASS') { const abs = q(1); add(this.P.bass, { abs, pitch: this.bassRoot(chordAt(abs)), vel: vel(0.8), dur: 2 + 2 * hold, sub: 1 }); }
      else if (role === 'MELODY') { const abs = q(2); add(this.P.lead, { abs, pitch: this.melodyNext(abs, chordAt(abs)), vel: vel(0.75), dur: 2 + 2 * hold, sub: 2 }); }
      else { this.padLevel = Math.min(1, this.padLevel + 0.35 + 0.4 * hold); add('PAD', { kind: 'CONTROL', abs: q(1), vel: this.padLevel, dur: 0, sub: 1 }); } // pad swells; no extra chord notes
    } else if (id === 'shake') {
      if (this.round === 'CLIMAX' || role === 'PULSE' || role === 'PERCUSSION') {
        if (this.round === 'CLIMAX') { const a = q(1); add('KICK', { abs: a, vel: vel(1), dur: 0.5 }); add('CLAP', { abs: a, vel: vel(0.9), dur: 0.5 }); }
        else { let a = Math.floor(now / 4) * 4 + 3; if (a < now) a += 4; for (let i = 0; i < 4; i++) add('CLAP', { abs: a + i * 0.25, vel: vel(0.5 + 0.1 * i), dur: 0.2, sub: 4 }); }
      } else if (role === 'BASS') {
        let a = Math.floor(now / 4) * 4 + 3.5; if (a < now) a += 4;
        const nr = this.bassRoot(chordAt(a + 1)), pitch = T.scalePitches(this.key, this.scale, 32, nr - 1).pop();
        if (pitch) add(this.P.bass, { abs: a, pitch, vel: vel(0.7), dur: 0.5, sub: 2 });
      } else if (role === 'HARMONY') {
        this.voiceBias++; const abs = q(1), vc = T.voicing(chordAt(abs), this.lastVoicing, this.voiceBias); this.lastVoicing = vc;
        vc.forEach((pitch) => add('SOFT_KEYS', { abs, pitch, vel: vel(0.45), dur: 1.5 }));
      } else if (role === 'MELODY') { const abs = q(2); add(this.P.lead, { abs, pitch: this.melodyNext(abs, chordAt(abs), -this.melody.dir), vel: vel(0.75), dur: 0.75, sub: 2 }); }
      else { this.texShift = this.texShift ? 0 : 12; const abs = q(2); add('BELL', { abs, pitch: this.textureTone(chordAt(abs)), vel: vel(0.5), dur: 1, sub: 2 }); }
    } else if (id === 'tilt') this.energy = Math.min(1, this.energy + 0.05 * Math.abs(g.value ?? 0));
    return out;
  }

  // ---- autonomous arrangement (14.7), planned one bar ahead
  planBar(b, nowMs) {
    const ch = this.chordForBar(b), base = b * 4, act = this.recentRoles(nowMs, 2 * this.barMs);
    const dens = this.density, A = (role, inst, o) => this.auto(role, inst, { abs: base + o.beat, sub: 1, ...o });
    const k = this.endBar === null ? -1 : b - this.endBar;
    if (k >= 0) {   // ---- ending: dominant -> tonic cadence, then one final collective hit with a long release
      const top = { pri: 999 }, r = this.bassRoot(ch);
      const pad = T.voicing(ch, this.lastVoicing); this.lastVoicing = pad;
      if (k <= 1) {
        pad.forEach((pitch) => A('HARMONY', 'PAD', { beat: 0, pitch, vel: 0.55, dur: 4, ...top }));
        A('BASS', this.P.bass, { beat: 0, pitch: r, vel: 0.8, dur: 2, ...top }); A('BASS', this.P.bass, { beat: 2, pitch: r + 7, vel: 0.7, dur: 2, ...top });
        A('PULSE', 'KICK', { beat: 0, vel: 0.9, dur: 0.25, ...top }); A('PULSE', 'KICK', { beat: 2, vel: 0.8, dur: 0.25, ...top });
        if (k === 1) { A('PERCUSSION', 'CLAP', { beat: 1, vel: 0.7, dur: 0.25, ...top }); A('PERCUSSION', 'CLAP', { beat: 3, vel: 0.8, dur: 0.25, ...top }); }
      } else {
        pad.forEach((pitch) => A('HARMONY', 'PAD', { beat: 0, pitch, vel: 0.8, dur: 8, ...top }));
        A('BASS', 'SUB_BASS', { beat: 0, pitch: r, vel: 0.9, dur: 6, ...top });
        A('PULSE', 'KICK', { beat: 0, vel: 1, dur: 0.5, ...top }); A('PERCUSSION', 'CLAP', { beat: 0, vel: 1, dur: 0.5, ...top });
        let bp = ch.rootMidi; while (bp < 72) bp += 12; while (bp > 84) bp -= 12;
        A('TEXTURE', 'BELL', { beat: 0, pitch: bp, vel: 0.7, dur: 6, ...top });
      }
      return;
    }
    const prog = clamp((b - this.roundStartBar) * this.barMs / (TIMING[this.round].max * 1000 * this.ts), 0, 1);
    const lvl = 0.8 + 0.2 * this.pulseLevel;
    if (!act.has('PULSE')) { A('PULSE', 'KICK', { beat: 0, vel: 0.8 * lvl, dur: 0.25 }); A('PULSE', 'KICK', { beat: 2, vel: 0.75 * lvl, dur: 0.25 });
      A('PERCUSSION', 'CLAP', { beat: 1, vel: 0.55, dur: 0.25 }); A('PERCUSSION', 'CLAP', { beat: 3, vel: 0.55, dur: 0.25 }); }
    if (!act.has('PERCUSSION') && (this.round !== 'CLIMAX' || dens < 0.7)) for (let i = 0; i < 8; i++) A('PERCUSSION', 'SHAKER', { beat: i * 0.5, vel: i % 2 ? 0.2 : 0.28, dur: 0.25, sub: 2 });
    if (this.round !== 'RHYTHM') {
      if (b % this.P.bpc === 0) { // one pad voicing per chord change, minimal voice movement
        const pad = T.voicing(ch, this.lastVoicing, this.voiceBias); this.lastVoicing = pad;
        pad.forEach((pitch) => A('HARMONY', 'PAD', { beat: 0, pitch, vel: 0.28 + 0.3 * this.padLevel, dur: 4 * this.P.bpc, art: 'LEGATO' }));
      }
      if (!act.has('BASS')) { const r = this.bassRoot(ch);
        A('BASS', this.P.bass, { beat: 0, pitch: r, vel: 0.75, dur: 2 }); A('BASS', this.P.bass, { beat: 2, pitch: this.round === 'CLIMAX' && r + 12 <= 52 ? r + 12 : r + 7, vel: 0.65, dur: 2 }); }
    }
    if ((this.round === 'MELODY' || this.round === 'CLIMAX') && !act.has('MELODY')) {
      const beats = this.round === 'CLIMAX' ? [0, 1, 2, 3] : [0, 2];
      for (const beat of beats) A('MELODY', this.P.lead, { beat, pitch: this.melodyNext(base + beat, ch), vel: 0.55, dur: 1, sub: 1 });
    }
    if (this.round === 'CLIMAX') {      // gradual lift: more texture, then busier hats
      if (!act.has('TEXTURE')) for (const beat of [1.5, 3.5]) A('TEXTURE', 'BELL', { beat, pitch: this.textureTone(ch), vel: 0.35, dur: 1, sub: 2 });
      if (prog > 0.5 && dens < 0.7) A('PERCUSSION', 'CLAP', { beat: 2.5, vel: 0.4, dur: 0.25, sub: 2 });
    }
  }

  // ---- main tick: plan ahead, transition rounds on bar boundaries, flush due events
  tick(nowMs) {
    const res = { events: [], newBars: [], roundChanged: false, finished: false };
    if (this.epochMs === null || this.finished) return res;
    this.updateDensity(nowMs);
    while (this.plannedBar < this.barAt(nowMs + L.PLAN_AHEAD_MS)) {
      const b = this.plannedBar + 1;
      if (this.endBar === null) {
        if (this.endRequested) this.endBar = b;
        else if (b > this.roundStartBar) {
          const T0 = TIMING[this.round], el = (b - this.roundStartBar) * this.barMs, min = T0.min * 1000 * this.ts, max = T0.max * 1000 * this.ts;
          if (this.forceAdvance || el >= max || (el >= min && (this.activity >= T0.thr || el >= 0.8 * max))) {
            this.forceAdvance = false;
            if (this.roundIdx < ROUNDS.length - 1) { this.roundIdx++; this.round = ROUNDS[this.roundIdx]; this.roundStartBar = b; res.roundChanged = true; if (this.hooks.assignRoles) this.hooks.assignRoles(this.round, this.roundIdx); }
            else { this.endRequested = true; this.endBar = b; }
          }
        }
        if (this.endBar === b && this.hooks.onEnding) this.hooks.onEnding(b);
      }
      if (this.endBar !== null && b >= this.endBar + 3) { this.plannedBar = b; break; }
      this.plannedBar = b; res.newBars.push(b);
      if (b >= 0) this.planBar(b, nowMs);
    }
    res.events = this.flush(nowMs);
    if (this.endBar !== null && nowMs >= this.msOfBeat((this.endBar + 3) * 4) + L.TAIL_MS) { this.finished = true; res.finished = true; }
    return res;
  }
}

module.exports = { Conductor, ROLES, ROUNDS, QUOTAS, EXPECTED, TIMING, LIMITS: L, roleCounts, assignRoleList };
