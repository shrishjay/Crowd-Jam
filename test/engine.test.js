const test = require('node:test'), assert = require('node:assert');
const T = require('../server/theory');
const { Conductor, ROLES, QUOTAS, EXPECTED, assignRoleList, roleCounts, LIMITS } = require('../server/conductor');
const { Room } = require('../server/rooms');
const { candidates } = require('../server/network');
const { encodeWav } = require('../public/wav');

// Simulate a whole session: N participants gesturing at random, 40 ms ticks, accelerated round timing.
function simulate({ preset = 'RADIANT', n = 12, seed = 12345, taps = 1.5, ts = 0.4, silent = false } = {}) {
  const cfg = T.makeConfig(preset, seed), roles = assignRoleList(n, 'RHYTHM', 0);
  const parts = roles.map((role, i) => ({ id: 'p' + i, role, slot: i }));
  let rr = 1;
  const rnd = () => ((rr = (rr * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const c = new Conductor(cfg, { connectedCount: () => (silent ? 0 : n), assignRoles: (r, idx) => { assignRoleList(n, r, idx).forEach((role, i) => (parts[i].role = role)); } }, { timeScale: ts });
  const t0 = 1e6; c.start(t0);
  const events = [], rounds = new Set(), perRound = {};
  let now = t0, ended = false;
  while (!c.finished && now < t0 + 600000) {
    now += 40;
    if (!silent && !c.endRequested) for (const p of parts) if (rnd() < taps * 0.04) c.gesture(p, { inputId: ['tap', 'tap', 'tap', 'hold_end', 'shake'][Math.floor(rnd() * 5)], value: rnd(), durationMs: 800 }, now);
    if (c.round === 'CLIMAX' && !ended && now > t0 + 100000) { /* let it run its natural course */ }
    const r = c.tick(now);
    rounds.add(c.round); perRound[c.round] = (perRound[c.round] || 0) + r.events.length;
    r.events.forEach((e) => events.push(e));
  }
  return { c, cfg, events, rounds, perRound, parts };
}

test('every pitched note belongs to the active scale (all presets, crowd chaos)', () => {
  for (const preset of Object.keys(T.PRESETS)) {
    const { cfg, events } = simulate({ preset });
    const notes = events.filter((e) => e.kind === 'NOTE' && e.pitchMidi !== undefined);
    assert.ok(notes.length > 100, 'enough notes were generated');
    for (const e of notes) assert.ok(T.inScale(e.pitchMidi, cfg.keyRootMidi, cfg.scale), `${preset}: pitch ${e.pitchMidi} (${e.instrument}) out of scale`);
  }
});

test('session passes through all four rounds, ends with a cadence and completes', () => {
  const { c, rounds, events } = simulate();
  assert.deepEqual([...rounds], ['RHYTHM', 'FOUNDATION', 'MELODY', 'CLIMAX']);
  assert.ok(c.finished && c.endBar > 0);
  const finalBar = events.filter((e) => e.targetBar === c.endBar + 2);
  assert.ok(finalBar.some((e) => e.instrument === 'KICK') && finalBar.some((e) => e.instrument === 'PAD' && e.durationBeats >= 8), 'final collective hit + long release');
  assert.equal(events.filter((e) => e.targetBar > c.endBar + 2).length, 0, 'nothing after the final hit');
});

test('event budgets: <=24 events/bar (excluding cadence), <=8 simultaneous pitched voices, bass <=1/beat', () => {
  const { c, events, cfg } = simulate({ n: 30, taps: 3 });
  const perBar = {}, ordinary = events.filter((e) => e.kind === "NOTE" && !(e.targetBar >= c.endBar));
  ordinary.forEach((e) => (perBar[e.targetBar] = (perBar[e.targetBar] || 0) + 1));
  assert.ok(Math.max(...Object.values(perBar)) <= LIMITS.BAR_EVENTS);
  const pitched = events.filter((e) => e.kind === 'NOTE' && !['KICK', 'SNARE', 'CLAP', 'SHAKER'].includes(e.instrument));
  for (const e of pitched) {
    const abs = e.targetBar * 4 + e.targetBeat - 1;
    const live = pitched.filter((o) => { const s = o.targetBar * 4 + o.targetBeat - 1; return s <= abs && abs < s + Math.max(0.25, o.durationBeats); }).length;
    assert.ok(live <= LIMITS.VOICES || e.targetBar >= c.endBar, `${live} voices at beat ${abs}`);
  }
  const bassPerBeat = {};
  events.filter((e) => ['SUB_BASS', 'PLUCK_BASS'].includes(e.instrument) && e.targetBar < c.endBar).forEach((e) => { const k = Math.floor(e.targetBar * 4 + e.targetBeat - 1); bassPerBeat[k] = (bassPerBeat[k] || 0) + 1; });
  assert.ok(Math.max(...Object.values(bassPerBeat)) <= LIMITS.BASS_BEAT);
});

test('strong-beat melody notes prefer chord tones; melody has no huge leaps', () => {
  const { events, c } = simulate({ n: 14, taps: 2 });
  const mel = events.filter((e) => e.role === 'MELODY' && e.kind === 'NOTE' && e.targetBar < c.endBar);
  const strong = mel.filter((e) => [0, 2].includes(Math.floor(e.targetBeat - 1)));
  const ok = strong.filter((e) => c.chordForBar(e.targetBar).pcs.includes(T.mod12(e.pitchMidi))).length;
  assert.ok(strong.length > 20 && ok / strong.length > 0.7, `chord-tone ratio ${ok}/${strong.length}`);
  const leaps = []; for (let i = 1; i < mel.length; i++) leaps.push(Math.abs(mel[i].pitchMidi - mel[i - 1].pitchMidi));
  assert.ok(leaps.filter((l) => l > 12).length / leaps.length < 0.1, 'mostly stepwise');
});

test('autonomous fallback keeps music moving with zero participants', () => {
  const { events, rounds, perRound } = simulate({ silent: true, n: 0, ts: 0.5 });
  assert.deepEqual([...rounds], ['RHYTHM', 'FOUNDATION', 'MELODY', 'CLIMAX']);
  assert.ok(events.every((e) => e.source === 'AUTONOMOUS'));
  assert.ok(perRound.RHYTHM > 20 && events.some((e) => e.role === 'MELODY') && events.some((e) => e.role === 'BASS') && events.some((e) => e.instrument === 'PAD'));
});

test('deterministic: same seed + same inputs => identical event log', () => {
  const a = simulate({ seed: 99 }).events.map((e) => [e.instrument, e.pitchMidi, e.targetBar, e.targetBeat, e.velocity]);
  const b = simulate({ seed: 99 }).events.map((e) => [e.instrument, e.pitchMidi, e.targetBar, e.targetBeat, e.velocity]);
  assert.deepEqual(a, b);
});

test('quantisation never goes backwards and lands on the grid', () => {
  assert.equal(T.quantizeBeat(1.0, 2), 1); assert.equal(T.quantizeBeat(1.01, 2), 1.5); assert.equal(T.quantizeBeat(3.76, 4), 4);
  for (let x = 0; x < 10; x += 0.173) for (const s of [1, 2, 4]) { const q = T.quantizeBeat(x, s); assert.ok(q >= x - 1e-9 && Math.abs(q * s - Math.round(q * s)) < 1e-9); }
});

test('role quotas: largest remainder sums to n, never more than 45% in one role', () => {
  for (const round of Object.keys(QUOTAS)) for (let n = 1; n <= 30; n++) {
    const counts = roleCounts(n, QUOTAS[round]);
    assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), n);
    if (n >= 5) assert.ok(Math.max(...Object.values(counts)) <= Math.ceil(0.45 * n) + 1);
  }
  assert.equal(assignRoleList(10, 'MELODY', 2).length, 10);
});

test('rate limits, duplicates, stale sequence, schema', () => {
  const r = new Room({ timeScale: 0.1 }); const { p } = r.join(); r.start('RADIANT'); p.role = 'PULSE';
  const g = (seq, id = 'tap') => ({ type: 'gesture', inputId: id, clientSequence: seq, value: 0.7 });
  let now = Date.now(); const res = [];
  for (let i = 0; i < 10; i++) res.push(r.handleGesture(p, g(i), now + i * 130).reason);   // 10 taps in ~1.3s
  assert.ok(res.includes('RATE_LIMITED'), res.join());
  assert.equal(r.handleGesture(p, g(3), now + 5000).reason, 'STALE_SEQUENCE');
  assert.equal(r.handleGesture(p, g(9), now + 5000).reason, 'DUPLICATE');
  assert.equal(r.handleGesture(p, { type: 'gesture', inputId: 'note_on', clientSequence: 99 }, now + 6000).reason, 'BAD_SCHEMA');
  assert.equal(r.handleGesture(p, { type: 'gesture', inputId: 'tap', clientSequence: 100, value: NaN }, now + 6000).reason, 'BAD_SCHEMA');
  assert.equal(r.handleGesture(p, { type: 'gesture', inputId: 'tap', clientSequence: 101, motion: { x: 5 } }, now + 6000).reason, 'BAD_SCHEMA');
  assert.equal(r.handleGesture(p, g(102), now + 9000).accepted, true);
});

test('phones never get an arbitrary note: only gestures are accepted', () => {
  const { validateGesture } = require('../server/protocol');
  assert.equal(validateGesture({ type: 'gesture', inputId: 'tap', clientSequence: 1, pitchMidi: 60, instrument: 'KICK' }).pitchMidi, undefined);
});

test('WAV encoder writes a valid header and clamps', () => {
  const buf = encodeWav([new Float32Array([0, 1, -1, 2]), new Float32Array([0, 0.5, -0.5, -2])], 44100), v = new DataView(buf);
  assert.equal(String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3)), 'RIFF');
  assert.equal(v.getUint32(24, true), 44100); assert.equal(v.getUint16(22, true), 2); assert.equal(v.getUint32(40, true), 16); assert.equal(buf.byteLength, 44 + 16);
  assert.equal(v.getInt16(44 + 4, true), 32767); assert.equal(v.getInt16(44 + 8, true), -32768);   // ch0: 1 -> max, -1 -> min
  assert.equal(v.getInt16(44 + 12, true), 32767); assert.equal(v.getInt16(44 + 14, true), -32768); // clamped 2 / -2
});

test('network: virtual adapters and link-local addresses are ranked below the real LAN', () => {
  const c = candidates({
    'vEthernet (Default Switch)': [{ family: 'IPv4', address: '172.29.80.1', internal: false }],
    'VMware Network Adapter VMnet8': [{ family: 'IPv4', address: '192.168.74.1', internal: false }],
    'OpenVPN Data Channel Offload': [{ family: 'IPv4', address: '169.254.169.10', internal: false }],
    Ethernet: [{ family: 'IPv4', address: '192.168.0.103', internal: false }],
  });
  assert.equal(c[0].ip, '192.168.0.103'); assert.ok(!c.some((x) => x.ip.startsWith('169.254')));
});
