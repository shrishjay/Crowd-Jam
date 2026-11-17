'use strict';
// Music theory primitives: scales, chords, voice leading, seeded randomness, quantisation.
const SCALES = { MAJOR: [0, 2, 4, 5, 7, 9, 11], MINOR: [0, 2, 3, 5, 7, 8, 10], PENTATONIC: [0, 2, 4, 7, 9] };
const QUALITY = { maj: [0, 4, 7], min: [0, 3, 7] };
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const KEY_ROOTS = [57, 60, 62, 64, 65, 67]; // A C D E F G: safe, comfortable keys

// Chords are scale-diatonic, so chord tones are always in the active scale.
const PRESETS = {
  RADIANT: { tempo: 108, scale: 'MAJOR', prog: [{ root: 0, q: 'maj' }, { root: 7, q: 'maj' }, { root: 9, q: 'min' }, { root: 5, q: 'maj' }],
    cad: [{ root: 7, q: 'maj' }, { root: 0, q: 'maj' }], bpc: 2, lead: 'BELL', bass: 'PLUCK_BASS' },
  CINEMATIC: { tempo: 92, scale: 'MINOR', prog: [{ root: 0, q: 'min' }, { root: 8, q: 'maj' }, { root: 3, q: 'maj' }, { root: 10, q: 'maj' }],
    cad: [{ root: 10, q: 'maj' }, { root: 0, q: 'min' }], bpc: 2, lead: 'FLUTE', bass: 'SUB_BASS' },
  PLAYFUL: { tempo: 116, scale: 'MAJOR', melodyPent: true, prog: [{ root: 0, q: 'maj' }, { root: 5, q: 'maj' }, { root: 7, q: 'maj' }, { root: 0, q: 'maj' }],
    cad: [{ root: 7, q: 'maj' }, { root: 0, q: 'maj' }], bpc: 1, lead: 'MARIMBA', bass: 'PLUCK_BASS' },
};

const mod12 = (n) => ((n % 12) + 12) % 12;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function mulberry32(seed) {
  let s = seed >>> 0;
  return function next() {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// One deterministic float per (seed, counter): every random choice in the engine uses this.
const rand = (seed, counter) => mulberry32((seed ^ Math.imul(counter + 1, 0x9e3779b1)) >>> 0)();

const inScale = (p, root, scale) => SCALES[scale].includes(mod12(p - root));
function scalePitches(root, scale, lo, hi, subset) {
  const iv = subset ? SCALES[subset] : SCALES[scale], out = [];
  for (let p = lo; p <= hi; p++) if (iv.includes(mod12(p - root))) out.push(p);
  return out;
}
function chordInfo(keyRoot, c) {
  const rootMidi = keyRoot + c.root, iv = QUALITY[c.q];
  return { sym: NOTE_NAMES[mod12(rootMidi)] + (c.q === 'min' ? 'm' : ''), rootMidi, rootPc: mod12(rootMidi), iv, pcs: iv.map((i) => mod12(rootMidi + i)) };
}
const chordWeight = (p, ch) => { const i = ch.pcs.indexOf(mod12(p)); return i < 0 ? 1 : [5, 4, 3][i]; };
const quantizeBeat = (absBeat, sub) => Math.ceil(absBeat * sub - 1e-9) / sub; // ceil: never schedule into the past

function weightedPick(items, weights, r) {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = r * total;
  for (let i = 0; i < items.length; i++) { x -= weights[i]; if (x < 0) return items[i]; }
  return items[items.length - 1];
}

// Melody candidate score (blueprint 13.7). strong = beats 1 and 3: chord tones matter most there.
function melodyScore(p, prev, ch, dir, lo, hi, strong, allowLeap) {
  const isChord = ch.pcs.includes(mod12(p)) ? 1 : 0;
  const dist = Math.abs(p - prev);
  const step = dist >= 1 && dist <= 4 ? 1 : 0.3;
  const contour = Math.sign(p - prev) === dir ? 1 : 0;
  const leap = allowLeap ? 0 : Math.max(0, dist - 7) / 12;
  const mid = (lo + hi) / 2, edge = Math.abs(p - mid) / ((hi - lo) / 2);
  return 3.0 * isChord * (strong ? 1 : 0.35) + 1.5 * step + 0.8 * contour - 2.0 * leap - 1.0 * edge * edge;
}

// Close-position triad inversion with the least total movement from the previous voicing.
function voicing(ch, prev, bias = 0) {
  let r = ch.rootMidi; while (r < 48) r += 12; while (r >= 60) r -= 12;
  const tri = ch.iv.map((i) => r + i);
  let best = null;
  for (let inv = 0; inv < 3; inv++) for (const shift of [0, 12]) {
    const v = tri.map((m, i) => (i < inv ? m + 12 : m) + shift).sort((a, b) => a - b);
    if (v[0] < 48 || v[2] > 72) continue;
    let cost = prev ? v.reduce((s, m, i) => s + Math.abs(m - prev[i]) + (Math.abs(m - prev[i]) > 5 ? 1.5 : 0), 0) : Math.abs(v[1] - 62);
    if (bias && inv === bias % 3) cost -= 3; // a "change voicing" shake nudges toward another inversion
    if (!best || cost < best.cost) best = { v, cost };
  }
  return best.v;
}

function makeConfig(preset, seed) {
  const P = PRESETS[preset];
  return { preset, tempoBpm: P.tempo, keyRootMidi: KEY_ROOTS[seed % KEY_ROOTS.length], scale: P.scale, meterNumerator: 4, meterDenominator: 4, maxParticipants: 30, seed };
}

module.exports = { SCALES, QUALITY, NOTE_NAMES, PRESETS, KEY_ROOTS, mod12, clamp, mulberry32, rand, inScale, scalePitches, chordInfo, chordWeight,
  quantizeBeat, weightedPick, melodyScore, voicing, makeConfig };
