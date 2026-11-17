// Host: owns the audio clock. Receives timestamped musical events from the server and schedules them on the WebAudio clock.
(() => {
  const $ = (id) => document.getElementById(id);
  const ROUNDS = ['RHYTHM', 'FOUNDATION', 'MELODY', 'CLIMAX'], ROLE_COLOR = { PULSE: '#ff4d6d', PERCUSSION: '#17a673', BASS: '#4d96ff', HARMONY: '#9b5de5', MELODY: '#e0a800', TEXTURE: '#e66fd2' };
  const S = { ctx: null, engine: null, ws: null, room: null, st: {}, offset: 0, bestRtt: Infinity, samples: [], queue: [], log: [], rendered: false, retry: 0, played: 0, created: 0 };
  window.__cs = S;
  $('rounds').innerHTML = ROUNDS.map((r) => `<div class="rd" data-r="${r}">${r[0] + r.slice(1).toLowerCase()}</div>`).join('');
  $('roles').innerHTML = Object.keys(ROLE_COLOR).map((r) => `<div class="role" id="role-${r}" style="background:${ROLE_COLOR[r]}"><b>0</b>${r[0] + r.slice(1).toLowerCase()}</div>`).join('');

  // ---------- audio ----------
  function ensureAudio() {
    if (!S.ctx) { S.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' }); S.engine = CrowdAudio.createEngine(S.ctx, { volume: +$('vol').value }); setInterval(pump, 25); setInterval(audioStatus, 500); }
    return S.ctx.resume();
  }
  function audioStatus() { const on = S.ctx && S.ctx.state === 'running'; $('audio').className = on ? 'on' : ''; $('audio').textContent = on ? 'Sound on' : 'Tap to enable sound'; }
  $('audio').onclick = () => ensureAudio();

  // The interval only FILLS the audio queue; every sound is triggered by a precise AudioContext time, never by the timer itself.
  function pump() {
    const ctx = S.ctx, horizon = ctx.currentTime + 0.2;
    while (S.queue.length && S.queue[0].t <= horizon) {
      const { t, ev } = S.queue.shift();
      S.engine.play(ev, Math.max(t, ctx.currentTime + 0.005), S.st.tempoBpm); S.played++;
      const b = $('role-' + ev.role); if (b) { b.classList.add('hit'); setTimeout(() => b.classList.remove('hit'), 90); }
    }
  }
  function schedule(ev) {
    if (!S.ctx || !S.st.epochServerMs) return;
    const bpm = S.st.tempoBpm, abs = ev.targetBar * 4 + ev.targetBeat - 1, serverMs = S.st.epochServerMs + (abs * 60000) / bpm;
    let t = S.ctx.currentTime + (serverMs - (Date.now() + S.offset)) / 1000;
    const grid = 60 / bpm / ev.subdivision, now = S.ctx.currentTime;
    if (t < now + 0.01) { if (now - t > (4 * 60) / bpm) return; t += Math.ceil((now + 0.01 - t) / grid) * grid; }   // late: next valid subdivision, or drop if stale
    if (t > now + (8 * 4 * 60) / bpm) return;                                                                      // never more than 8 bars ahead
    if (S.lastSeq && ev.sequence <= S.lastSeq) return; S.lastSeq = ev.sequence;                                    // duplicates / out of order
    S.queue.push({ t, ev }); S.queue.sort((a, b) => a.t - b.t);
  }

  // ---------- network ----------
  const api = (path, body, tok) => fetch(path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
  function showRoom(r) {
    $('qr').innerHTML = r.qr; $('code').textContent = r.joinCode; $('url').textContent = r.joinUrl;
    const sel = $('addr'); sel.innerHTML = r.candidates.map((c) => `<option value="${c.ip}" ${c.ip === r.ip ? 'selected' : ''}>${c.ip} (${c.name}${c.virtual ? ', virtual' : ''})</option>`).join('');
    $('addrWrap').classList.toggle('hidden', r.candidates.length < 2);
  }
  $('addr').onchange = async () => { const r = await api(`/api/rooms/${S.room.roomId}/address`, { ip: $('addr').value }, S.room.hostToken); if (r.qr) { $('qr').innerHTML = r.qr; $('url').textContent = r.joinUrl; } };
  $('create').onclick = async () => {
    await ensureAudio(); $('create').disabled = true;
    S.room = await api('/api/rooms', { preset: $('preset').value }); showRoom(S.room); S.created = Date.now(); connect(); $('start').disabled = false;
    setTimeout(() => { if (!S.st.participants && S.st.status === 'LOBBY') {
      $('warn').classList.remove('hidden');
      $('warn').innerHTML = 'No phone has joined yet. Check: phone and laptop on the <b>same Wi-Fi</b> (guest/venue Wi-Fi often isolates devices, so use a phone hotspot); pick the right <b>Address</b> above (Wi-Fi/Ethernet, not VMware/Hyper-V/VPN); Windows firewall must allow inbound TCP 3000 (<code>netsh advfirewall firewall add rule name=CrowdSynth dir=in action=allow protocol=TCP localport=3000</code> in an admin terminal).'; } }, 45000);
  };
  function connect() {
    const ws = (S.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?roomId=${S.room.roomId}&clientType=host&token=${S.room.hostToken}`));
    ws.onopen = () => { S.retry = 0; $('net').textContent = 'connected'; ping(); };
    ws.onclose = () => { $('net').textContent = 'server disconnected, retrying (audio keeps playing what is scheduled)'; setTimeout(connect, Math.min(8000, 500 * 2 ** S.retry++)); };
    ws.onmessage = (e) => handle(JSON.parse(e.data));
  }
  function ping() { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ type: 'ping', clientTimeMs: Date.now() })); setTimeout(ping, S.samples.length < 12 ? 400 : 5000); }
  function handle(m) {
    if (m.type === 'pong') {            // keep the offset from the lowest-RTT sample (least network jitter)
      const t1 = Date.now(), rtt = t1 - m.clientTimeMs, off = m.serverTimeMs + rtt / 2 - t1;
      S.samples.push({ rtt, off }); if (S.samples.length > 12) S.samples.shift(); S.offset = S.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).off;
    } else if (m.type === 'snapshot' || m.type === 'state_update') state(m);
    else if (m.type === 'musical_event') { S.log.push(m.event); schedule(m.event); feed(m.event); }
  }
  function feed(e) { const f = $('feed'); const line = document.createElement('div'); line.textContent = `${e.source === 'AUTONOMOUS' ? 'auto' : 'crowd'}  ${e.role.toLowerCase()}  ${e.instrument.toLowerCase()}${e.pitchMidi ? ' ' + e.pitchMidi : ''}${e.contributors > 1 ? ' x' + e.contributors : ''}`; f.prepend(line); while (f.children.length > 7) f.lastChild.remove(); }

  // ---------- dashboard ----------
  function state(m) {
    S.st = m; const live = ['RUNNING', 'PAUSED', 'FINALIZING', 'COMPLETE'].includes(m.status);
    $('count').textContent = m.participants; $('sPeople').textContent = m.participants; $('pulse').style.transform = `scale(${1 + m.activity})`;
    $('lobby').classList.toggle('hidden', live); $('live').classList.toggle('hidden', !live);
    $('sTempo').textContent = m.tempoBpm; $('sKey').textContent = m.key; $('sChord').textContent = m.chord || '-'; $('sBar').textContent = `${m.bar + 1} / ${m.beat}`;
    $('sEvents').textContent = S.played; $('energy').value = Math.max(m.energy, m.densityTarget - 0.15);
    const idx = ROUNDS.indexOf(m.round); document.querySelectorAll('.rd').forEach((d, i) => { d.className = 'rd' + (i === idx ? ' cur' : i < idx ? ' done' : ''); });
    for (const r in m.roles) $('role-' + r).firstChild.textContent = m.roles[r];
    $('status').textContent = { RUNNING: 'Performing', PAUSED: 'Paused', FINALIZING: 'Final cadence...', COMPLETE: 'Complete' }[m.status] || '';
    if (m.status === 'COMPLETE' && !S.rendered) exportWav();
  }
  const ctl = (action, extra) => S.ws && S.ws.readyState === 1 && S.ws.send(JSON.stringify({ type: 'host_control', action, ...extra }));
  $('start').onclick = async () => { await ensureAudio(); ctl('start', { preset: $('preset').value }); };
  $('pause').onclick = () => ctl('pause'); $('resume').onclick = () => ctl('resume'); $('next').onclick = () => ctl('advance_round'); $('end').onclick = () => ctl('end');
  $('vol').oninput = () => S.engine && S.engine.setVolume(+$('vol').value);

  // ---------- export: render the event log (source of truth), never the speakers ----------
  async function exportWav() {
    S.rendered = true; $('export').classList.remove('hidden');
    try {
      const data = await api(`/api/rooms/${S.room.roomId}/export`, null, S.room.hostToken);
      const r = await CrowdAudio.renderComposition(data.events, data.metadata); S.exported = { ...r, events: data.events.length };
      const blob = new Blob([r.wav], { type: 'audio/wav' }), url = URL.createObjectURL(blob), name = `crowdsynth-${S.room.joinCode}.wav`;
      $('exTitle').textContent = data.metadata.title; $('exMeta').textContent = `${data.metadata.key}, ${data.metadata.tempoBpm} BPM, ${r.duration.toFixed(1)} s, ${data.events.length} events, ${data.metadata.participantCount} participants, peak ${r.peak.toFixed(2)}`;
      $('player').src = url; $('player').classList.remove('hidden');
      const dl = $('dl'); dl.style.display = 'inline-block'; dl.href = url; dl.download = name;
      if (window.AndroidBridge) { dl.onclick = (e) => { e.preventDefault(); const rd = new FileReader(); rd.onload = () => AndroidBridge.saveFile(name, String(rd.result).split(',')[1]); rd.readAsDataURL(blob); }; }
    } catch (e) { $('exTitle').textContent = 'Render failed: the event log is kept, press End again or reload to retry.'; S.rendered = false; }
  }
})();
