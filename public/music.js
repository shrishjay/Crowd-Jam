// The "conductor": turns random crowd taps into music. Pure logic (no audio, no DOM) so it runs in the
// host browser and in Node tests. Every tap goes through: rate limit -> role -> grid quantize ->
// scale lock -> chord snap -> leap limit -> crowd consensus. Nothing the crowd does can leave the key.
(function (root) {
  const BPM = 100, ROOT = 57;                    // A3; key = A minor
  const PENT = [0, 3, 5, 7, 10];                 // minor pentatonic: no note in it clashes with any chord below
  const PROG = [{ r: 0, t: [0, 3, 7] }, { r: -4, t: [0, 4, 7] }, { r: 3, t: [0, 4, 7] }, { r: -2, t: [0, 4, 7] }]; // Am F C G
  const DOM = { r: 7, t: [0, 4, 7] };            // E major: dominant, pulls back to Am for the ending
  const RATE = 4, BURST = 3;                     // per-phone taps/sec and burst
  const MAXLEAP = 3;                             // max melody jump, in scale steps
  const SEQ = [0, 1, 2, 3, 2, 1];                // arpeggio shape
  const mod12 = (n) => ((n % 12) + 12) % 12;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const LEAD = [];
  for (let m = ROOT + 12; m <= ROOT + 31; m++) if (PENT.includes(mod12(m - ROOT))) LEAD.push(m);
  const drumOf = (x) => (x < 0.33 ? 'kick' : x < 0.66 ? 'snare' : 'hat');

  class Conductor {
    constructor({ bars = 40 } = {}) {
      this.bars = bars; this.pending = []; this.buckets = {}; this.lastLead = null; this.arpI = 0;
      this.act = 0; this.log = [];
    }
    get steps() { return this.bars * 16; }
    chordAt(bar) { return bar === this.bars - 2 ? DOM : bar >= this.bars - 1 ? PROG[0] : PROG[bar % 4]; }
    section(bar) { return bar < 8 ? 0 : bar < this.bars - 10 ? 1 : bar < this.bars - 2 ? 2 : 3; } // intro, groove, peak, ending

    // Called for every tap. Returns false if rate-limited. now = seconds.
    input(id, role, x, y, now) {
      const b = this.buckets[id] || (this.buckets[id] = { tok: BURST, t: now });
      b.tok = Math.min(BURST, b.tok + (now - b.t) * RATE); b.t = now;
      if (b.tok < 1 || this.pending.length > 256) return false;
      b.tok -= 1;
      this.pending.push({ role, x: clamp(+x || 0, 0, 1), age: 0 });
      return true;
    }

    // Called once per 16th note (n = absolute step). Returns the events to play on that step.
    step(n) {
      const bar = Math.floor(n / 16), s = n % 16, ev = [];
      if (bar >= this.bars) return ev;
      const chord = this.chordAt(bar), sec = this.section(bar), ending = bar === this.bars - 1;
      const pcs = chord.t.map((t) => mod12(ROOT + chord.r + t));
      const tones = chord.t.map((t) => ROOT + chord.r + t);

      // quantize: a tap waits (max 8 steps) for the next step its role/piece is allowed to sound on
      const gate = {
        lead: () => s % 2 === 0, bass: () => s % 2 === 0, arp: () => true, pad: () => s % 4 === 0,
        drums: (p) => { const k = drumOf(p.x); return k === 'kick' ? s % 4 === 0 : k === 'snare' ? s % 8 === 4 : s % 2 === 0; },
      };
      const hits = { lead: [], bass: [], arp: [], pad: [], drums: [] }, rest = [];
      for (const p of this.pending) (gate[p.role] && gate[p.role](p) && !ending ? hits[p.role] : rest).push(p);
      this.pending = ending ? [] : rest.filter((p) => ++p.age <= 8);
      this.act = this.act * 0.98 + hits.pad.length;
      const med = (a) => a.map((p) => p.x).sort((u, v) => u - v)[a.length >> 1]; // crowd consensus

      if (ending) {
        if (s === 0) ev.push({ role: 'pad', notes: tones, vel: 0.9, dur: 16 }, { role: 'bass', notes: [ROOT - 12], vel: 0.8, dur: 16 },
          { role: 'lead', notes: [ROOT + 24], vel: 0.7, dur: 16 }, { role: 'drums', drum: 'kick', vel: 1 });
      } else {
        // pad: harmony is guaranteed once per bar; crowd taps re-strike it with a different voicing
        if (s === 0 || hits.pad.length) {
          const inv = hits.pad.length ? Math.floor(med(hits.pad) * 2.99) : 0;
          const notes = tones.map((m, i) => (i < inv ? m + 12 : m)).sort((a, b) => a - b);
          ev.push({ role: 'pad', notes, vel: clamp(0.3 + 0.1 * hits.pad.length + 0.2 * Math.min(1, this.act / 4), 0, 1), dur: s === 0 ? 16 : 4 });
        }
        // lead: one note per 8th = median of everyone's pick, leap-limited, snapped to chord tones on beats
        if (hits.lead.length) {
          let i = Math.round(med(hits.lead) * (LEAD.length - 1)), lo = 0, hi = LEAD.length - 1;
          if (this.lastLead !== null) { lo = Math.max(0, this.lastLead - MAXLEAP); hi = Math.min(hi, this.lastLead + MAXLEAP); }
          i = clamp(i, lo, hi);
          if (s % 4 === 0) {
            let best = null;
            for (let k = lo; k <= hi; k++) if (pcs.includes(mod12(LEAD[k])) && (best === null || Math.abs(k - i) < Math.abs(best - i))) best = k;
            if (best !== null) i = best;
          }
          this.lastLead = i;
          ev.push({ role: 'lead', notes: [LEAD[i]], vel: clamp(0.5 + 0.12 * hits.lead.length, 0, 1), dur: 2 });
        }
        // bass: root / fifth / octave of the CURRENT chord, one note per 8th
        if (hits.bass.length) {
          const x = med(hits.bass), base = ROOT - 12 + chord.r;
          ev.push({ role: 'bass', notes: [x < 0.45 ? base : x < 0.8 ? base + 7 : base + 12], vel: clamp(0.6 + 0.1 * hits.bass.length, 0, 1), dur: 2 });
        }
        // arp: walks the chord tones; many taps = louder, never faster than one note per 16th
        if (hits.arp.length) {
          const t4 = [tones[0] + 12, tones[1] + 12, tones[2] + 12, tones[0] + 24];
          ev.push({ role: 'arp', notes: [t4[SEQ[this.arpI++ % SEQ.length]]], vel: clamp(0.35 + 0.1 * hits.arp.length, 0, 0.8), dur: 1 });
        }
        // drums: taps pick kick/snare/hat but only land on steps where that drum makes sense; backing groove fills the rest
        const played = new Set(hits.drums.map((p) => drumOf(p.x)));
        for (const k of played) ev.push({ role: 'drums', drum: k, vel: 0.85 });
        const back = (k, vel) => { if (!played.has(k)) ev.push({ role: 'drums', drum: k, vel }); };
        if (sec === 1 && s % 8 === 0) back('kick', 0.7);
        if (sec === 2) { if (s % 4 === 0) back('kick', 0.8); if (s === 4 || s === 12) back('snare', 0.6); }
        if (sec >= 1 && s % 2 === 0) back('hat', sec === 2 ? 0.3 : 0.2);
      }
      if (ev.length) this.log.push({ n, ev });
      return ev;
    }
  }

  const api = { Conductor, BPM, ROOT, LEAD, PENT, PROG, DOM, MAXLEAP, BURST, mod12 };
  if (typeof module !== 'undefined') module.exports = api; else root.Music = api;
})(this);
