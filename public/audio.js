// Host audio engine. One instrument factory used by BOTH the live context and the OfflineAudioContext export renderer,
// so the exported WAV is rendered from the event log with exactly the same sounds. Nothing here is a prerecorded sample.
(function (root) {
  const BUS = { KICK: 'drums', SNARE: 'drums', CLAP: 'drums', SHAKER: 'drums', SUB_BASS: 'bass', PLUCK_BASS: 'bass', SOFT_KEYS: 'harmony', PAD: 'harmony',
    CHOIR: 'harmony', SYNTH_LEAD: 'melody', FLUTE: 'melody', MARIMBA: 'melody', BELL: 'texture' };
  const LEVEL = { drums: 0.65, bass: 0.45, harmony: 0.3, melody: 0.45, texture: 0.25 };
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function createEngine(ctx, opts = {}) {
    const stats = { played: 0, byInstrument: {} };
    const out = ctx.createGain(), lp = ctx.createBiquadFilter(), comp = ctx.createDynamicsCompressor(), master = ctx.createGain();
    lp.type = 'lowpass'; lp.frequency.value = 14000;                     // EQ / filter stage
    comp.threshold.value = -14; comp.knee.value = 20; comp.ratio.value = 6; comp.attack.value = 0.004; comp.release.value = 0.2; // limiter-ish
    master.gain.value = opts.volume ?? 0.7;
    out.connect(lp); lp.connect(comp); comp.connect(master); master.connect(ctx.destination);
    const buses = {}, send = ctx.createGain(), echo = ctx.createDelay(1), fb = ctx.createGain(), wet = ctx.createGain();
    echo.delayTime.value = 0.33; fb.gain.value = 0.3; wet.gain.value = 0.25; send.gain.value = 1;
    send.connect(echo); echo.connect(fb); fb.connect(echo); echo.connect(wet); wet.connect(out);
    for (const k in LEVEL) { buses[k] = ctx.createGain(); buses[k].gain.value = LEVEL[k]; buses[k].connect(out); if (k === 'melody' || k === 'texture') buses[k].connect(send); }
    const padTrim = ctx.createGain(); padTrim.gain.value = 0.8; padTrim.connect(buses.harmony);
    const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), nd = noise.getChannelData(0);
    for (let i = 0, s = 1; i < nd.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; nd[i] = s / 2147483648 - 1; } // deterministic noise

    const env = (g, t, a, peak, dur, r) => { g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.setTargetAtTime(0, t + Math.max(a, dur), r); };
    function tone(type, freq, t, dur, vel, dest, o = {}) {
      const osc = ctx.createOscillator(), g = ctx.createGain(); let node = osc;
      osc.type = type; osc.frequency.value = freq; if (o.det) osc.detune.value = o.det;
      if (o.cut) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.cut; osc.connect(f); node = f; }
      env(g, t, o.a ?? 0.01, vel * (o.gain ?? 0.3), dur, o.r ?? 0.1);
      node.connect(g); g.connect(dest); osc.start(t); osc.stop(t + dur + (o.r ?? 0.1) * 8 + 0.05);
      return osc;
    }
    function burst(t, len, vel, dest, type, freq, q) {
      const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      src.buffer = noise; f.type = type; f.frequency.value = freq; f.Q.value = q || 1;
      g.gain.setValueAtTime(vel, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
      src.connect(f); f.connect(g); g.connect(dest); src.start(t); src.stop(t + len + 0.02);
    }
    const INS = {
      KICK: (t, d, v, o) => { const osc = ctx.createOscillator(), g = ctx.createGain(); osc.frequency.setValueAtTime(150, t); osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
        g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.32); osc.connect(g); g.connect(o); osc.start(t); osc.stop(t + 0.35); },
      SNARE: (t, d, v, o) => { burst(t, 0.18, v * 0.8, o, 'bandpass', 1800, 0.8); tone('triangle', 190, t, 0.05, v, o, { gain: 0.5, r: 0.04 }); },
      CLAP: (t, d, v, o) => { [0, 0.012, 0.024].forEach((x) => burst(t + x, 0.03, v * 0.5, o, 'bandpass', 1300, 1)); burst(t + 0.03, 0.15, v * 0.6, o, 'bandpass', 1300, 1); },
      SHAKER: (t, d, v, o) => burst(t, 0.06, v * 0.5, o, 'highpass', 6500, 0.7),
      SUB_BASS: (t, d, v, o, m) => { tone('sine', mtof(m), t, d, v, o, { gain: 0.75, r: 0.1 }); tone('triangle', mtof(m), t, d, v, o, { gain: 0.2, cut: 500, r: 0.1 }); },
      PLUCK_BASS: (t, d, v, o, m) => { const f = ctx.createBiquadFilter(), g = ctx.createGain(), osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = mtof(m);
        f.type = 'lowpass'; f.frequency.setValueAtTime(1400, t); f.frequency.exponentialRampToValueAtTime(200, t + Math.min(d, 0.5)); env(g, t, 0.005, v * 0.45, d * 0.8, 0.08);
        osc.connect(f); f.connect(g); g.connect(o); osc.start(t); osc.stop(t + d + 0.8); },
      SOFT_KEYS: (t, d, v, o, m) => { tone('triangle', mtof(m), t, d * 0.7, v, o, { gain: 0.35, cut: 3000, a: 0.008, r: 0.25 }); tone('sine', mtof(m) * 2, t, d * 0.4, v, o, { gain: 0.1, r: 0.15 }); },
      MARIMBA: (t, d, v, o, m) => { tone('sine', mtof(m), t, 0.12, v, o, { gain: 0.5, a: 0.003, r: 0.14 }); tone('sine', mtof(m) * 4, t, 0.02, v, o, { gain: 0.2, a: 0.002, r: 0.03 }); },
      BELL: (t, d, v, o, m) => [[1, 1], [2.76, 0.5], [5.4, 0.25], [8.93, 0.12]].forEach(([r, a]) => tone('sine', mtof(m) * r, t, 0.05, v * a, o, { gain: 0.25, a: 0.002, r: Math.max(0.35, d * 0.25) / r })),
      SYNTH_LEAD: (t, d, v, o, m) => [-7, 7].forEach((det) => tone('sawtooth', mtof(m), t, d, v, o, { gain: 0.14, cut: 3200, a: 0.012, r: 0.15, det })),
      FLUTE: (t, d, v, o, m) => { const x = tone('sine', mtof(m), t, d, v, o, { gain: 0.35, a: 0.06, r: 0.15 }), lfo = ctx.createOscillator(), lg = ctx.createGain();
        lfo.frequency.value = 5; lg.gain.value = 6; lfo.connect(lg); lg.connect(x.detune); lfo.start(t); lfo.stop(t + d + 1.5); tone('triangle', mtof(m), t, d, v, o, { gain: 0.12, a: 0.06, r: 0.15 }); },
      PAD: (t, d, v, o, m) => [-9, 9].forEach((det) => tone('sawtooth', mtof(m), t, d, v, o, { gain: 0.05, cut: 1100, a: 0.3, r: 0.6, det })),
    };
    INS.CHOIR = INS.PAD;

    return {
      ctx, master, buses, stats,
      setVolume(v) { master.gain.setTargetAtTime(v, ctx.currentTime, 0.05); },
      control(ev, when) { if (ev.instrument === 'PAD') padTrim.gain.setTargetAtTime(0.6 + 0.9 * ev.velocity, when, 0.25); },   // hold gesture = pad swell
      play(ev, when, bpm) {
        if (ev.kind === 'CONTROL') return this.control(ev, when);
        const fn = INS[ev.instrument]; if (!fn) return;
        const pan = ctx.createStereoPanner(); pan.pan.value = ev.pan || 0;
        pan.connect(ev.instrument === 'PAD' ? padTrim : buses[BUS[ev.instrument]]);
        fn(when, Math.max(0.05, ev.durationBeats * 60 / bpm), ev.velocity, pan, ev.pitchMidi);
        stats.played++; stats.byInstrument[ev.instrument] = (stats.byInstrument[ev.instrument] || 0) + 1;
      },
    };
  }

  // Render the whole event log offline -> WAV (never records the speakers).
  async function renderComposition(events, meta) {
    const sr = 44100, beat = 60 / meta.tempoBpm, abs = (e) => e.targetBar * 4 + e.targetBeat - 1;
    const end = events.reduce((m, e) => Math.max(m, abs(e) + (e.durationBeats || 0)), 4), dur = end * beat + 3;   // 3 s release tail
    const off = new OfflineAudioContext(2, Math.ceil(dur * sr), sr), eng = createEngine(off, { volume: 0.7 });
    for (const e of events) eng.play(e, abs(e) * beat, meta.tempoBpm);
    const buf = await off.startRendering(), ch = [buf.getChannelData(0), buf.getChannelData(1)];
    let peak = root.CrowdWav.peak(ch); if (peak > 0.98) { const k = 0.95 / peak; ch.forEach((c) => { for (let i = 0; i < c.length; i++) c[i] *= k; }); peak = 0.95; }
    return { wav: root.CrowdWav.encodeWav(ch, sr), duration: buf.duration, peak, sampleRate: sr };
  }

  root.CrowdAudio = { createEngine, renderComposition };
})(window);
