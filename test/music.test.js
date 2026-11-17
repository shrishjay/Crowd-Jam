const test = require('node:test'), assert = require('node:assert');
const { Conductor, PENT, ROOT, MAXLEAP, LEAD, DOM, PROG, BURST, mod12 } = require('../public/music.js');

// Worst case crowd: 30 phones tapping uniformly random roles/positions as fast as they like.
function chaos(bars = 40) {
  const c = new Conductor({ bars }), roles = ['lead', 'bass', 'pad', 'arp', 'drums'], out = [];
  let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  for (let n = 0; n < c.steps; n++) {
    const now = n * 0.15;
    for (let k = 0; k < 40; k++) c.input(Math.floor(rnd() * 30), roles[Math.floor(rnd() * 5)], rnd(), rnd(), now);
    for (const e of c.step(n)) out.push({ n, ...e });
  }
  return { c, out };
}

test('every pitched note stays in key (A minor pentatonic or the current chord)', () => {
  const { c, out } = chaos();
  for (const e of out.filter((e) => e.notes)) {
    const bar = Math.floor(e.n / 16), ch = c.chordAt(bar);
    const ok = new Set([...PENT.map((p) => mod12(ROOT + p)), ...ch.t.map((t) => mod12(ROOT + ch.r + t))]);
    for (const m of e.notes) assert.ok(ok.has(mod12(m)), `note ${m} out of key in bar ${bar}`);
  }
});

test('per-phone rate limit holds', () => {
  const c = new Conductor();
  let ok = 0; for (let i = 0; i < 1000; i++) ok += c.input('a', 'lead', 0.5, 0.5, 0) ? 1 : 0;
  assert.equal(ok, BURST);
});

test('at most one melody note per 8th, never faster; melody never leaps more than MAXLEAP', () => {
  const { out } = chaos(), lead = out.filter((e) => e.role === 'lead' && e.dur === 2);
  for (let i = 1; i < lead.length; i++) {
    assert.ok(lead[i].n - lead[i - 1].n >= 2);
    assert.ok(Math.abs(LEAD.indexOf(lead[i].notes[0]) - LEAD.indexOf(lead[i - 1].notes[0])) <= MAXLEAP);
  }
});

test('notes per step are bounded (no wall of noise)', () => {
  const { out } = chaos(), per = {};
  out.forEach((e) => (per[e.n] = (per[e.n] || 0) + 1));
  assert.ok(Math.max(...Object.values(per)) <= 8);
});

test('piece ends on E major -> A minor with a held final chord and silence after', () => {
  const { c, out } = chaos();
  assert.deepEqual(c.chordAt(c.bars - 2), DOM); assert.deepEqual(c.chordAt(c.bars - 1), PROG[0]);
  const last = out.filter((e) => e.n >= (c.bars - 1) * 16);
  assert.ok(last.every((e) => e.n === (c.bars - 1) * 16));
  assert.ok(last.some((e) => e.role === 'pad' && e.dur === 16));
  assert.equal(c.step(c.steps).length, 0);
});
