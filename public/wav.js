// PCM16 WAV encoder (pure; works in the browser and in Node tests).
(function (root) {
  function encodeWav(channels, sampleRate) {
    const n = channels[0].length, ch = channels.length, bytes = new ArrayBuffer(44 + n * ch * 2), v = new DataView(bytes);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * ch * 2, true);
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, s < 0 ? s * 32768 : s * 32767, true); o += 2;
    }
    return bytes;
  }
  function peak(channels) { let p = 0; for (const c of channels) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > p) p = a; } return p; }
  const api = { encodeWav, peak };
  if (typeof module !== 'undefined') module.exports = api; else root.CrowdWav = api;
})(this);
