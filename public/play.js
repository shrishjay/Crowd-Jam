// Participant: input capture + feedback only. Sends gestures (never notes); the server decides the music.
(() => {
  const $ = (id) => document.getElementById(id);
  const code = (location.pathname.split('/').filter(Boolean).pop() || new URLSearchParams(location.search).get('room') || '').toUpperCase();
  const KEY = 'cs:' + code, SEQ = 'cs:seq:' + code;
  const ROLE = {
    PULSE: ['Heartbeat', '#ff4d6d', 'Tap to add a beat', 'Hold to build the pulse. Shake for a fill'],
    PERCUSSION: ['Percussion', '#17a673', 'Tap to add a clap or shake', 'Hold for a roll. Shake for a fill'],
    BASS: ['Bass', '#4d96ff', 'Tap to add a bass note', 'Hold to sustain. Shake for a pickup'],
    HARMONY: ['Harmony', '#9b5de5', 'Tap to play a chord tone', 'Hold to swell the pad. Shake to change voicing'],
    MELODY: ['Melody', '#e0a800', 'Tap to play the next note of the tune', 'Hold to lengthen it. Shake to flip direction'],
    TEXTURE: ['Sparkle', '#e66fd2', 'Tap to add a sparkle', 'Hold to raise the pad. Shake to shift register'],
  };
  const ROUND = { RHYTHM: 'Round 1: Rhythm', FOUNDATION: 'Round 2: Foundation', MELODY: 'Round 3: Melody', CLIMAX: 'Round 4: Finale' };
  const S = { ws: null, tok: null, status: 'LOBBY', role: 'PERCUSSION', retry: 0, seq: +sessionStorage.getItem(SEQ) || 0, holdTimer: null, holdStart: 0, holding: false, lastShake: 0 };
  const pad = $('pad');
  const set = (id, t) => ($(id).textContent = t);
  const conn = (cls, text) => { $('dot').className = cls; set('conn', text); };

  function render() {
    const [name, color, tap, more] = ROLE[S.role], on = S.status === 'RUNNING';
    pad.style.setProperty('--c', color); pad.classList.toggle('off', !on); set('role', name);
    set('instr', S.status === 'COMPLETE' || S.status === 'FINALIZING' ? 'Listen: this is what you made together' : on ? tap : S.status === 'PAUSED' ? 'Paused' : 'Waiting for the host to start...');
    set('sub', on ? more : ''); set('round', ROUND[S.round] || 'Waiting for the host');
  }
  function apply(m) { if (m.role) S.role = m.role; if (m.status) S.status = m.status; if (m.round) S.round = m.round; render(); }

  async function join() {
    let saved = null; try { saved = JSON.parse(sessionStorage.getItem(KEY)); } catch {}
    if (!saved) {
      const r = await fetch(`/api/rooms/${code}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!r.ok) { conn('bad', r.status === 404 ? 'Room not found' : r.status === 410 ? 'Session already ended' : 'Room is full'); set('instr', r.status === 404 ? 'Check the code on the host screen' : 'Sorry, you cannot join this one'); return; }
      saved = await r.json(); saved.roomId = saved.snapshot.roomId; try { sessionStorage.setItem(KEY, JSON.stringify(saved)); } catch {}
    }
    S.tok = saved; set('alias', saved.alias); apply(saved.snapshot); connect();
  }
  function connect() {
    const ws = (S.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?roomId=${S.tok.roomId}&clientType=participant&token=${S.tok.token}`));
    ws.onopen = () => { S.retry = 0; conn('ok', 'Connected'); heartbeat(); };
    ws.onclose = () => { conn('bad', 'Reconnecting...'); setTimeout(connect, Math.min(8000, 400 * 2 ** S.retry++)); };   // exponential backoff
    ws.onerror = () => {};
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'snapshot' || m.type === 'state_update') apply(m);
      if (m.type === 'gesture_ack') ack(m);
    };
  }
  function heartbeat() { if (S.ws && S.ws.readyState === 1) { S.ws.send(JSON.stringify({ type: 'ping', clientTimeMs: Date.now() })); setTimeout(heartbeat, 5000); } }
  function ack(m) {
    const el = $('ack'); el.textContent = m.accepted ? '' : m.reason === 'RATE_LIMITED' ? 'Easy there, try a slower tap' : '';
    el.classList.toggle('show', !m.accepted && m.reason === 'RATE_LIMITED'); if (!m.accepted) setTimeout(() => el.classList.remove('show'), 700);
  }
  function send(inputId, extra) {
    if (S.status !== 'RUNNING' || !S.ws || S.ws.readyState !== 1) return false;
    S.seq++; try { sessionStorage.setItem(SEQ, S.seq); } catch {}
    S.ws.send(JSON.stringify({ type: 'gesture', inputId, clientSequence: S.seq, clientTimeMs: Date.now(), ...extra })); return true;
  }

  // Tap fires immediately on pointerdown (no wait for release = lowest latency); a press longer than 350 ms becomes a hold.
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault(); pad.setPointerCapture(e.pointerId); pad.classList.add('press');
    const v = e.pressure > 0 && e.pointerType !== 'mouse' ? Math.min(1, 0.4 + e.pressure) : 0.6 + Math.random() * 0.3;
    if (send('tap', { value: v })) { feedback(e); navigator.vibrate && navigator.vibrate(8); }
    S.holdStart = Date.now(); S.holding = false;
    S.holdTimer = setTimeout(() => { S.holding = true; send('hold_start', { value: 0.7 }); S.holdTimer = setInterval(() => send('hold_update', { value: Math.min(1, (Date.now() - S.holdStart) / 2000) }), 300); }, 350);
  });
  const release = () => {
    pad.classList.remove('press'); clearTimeout(S.holdTimer); clearInterval(S.holdTimer);
    if (S.holding) { send('hold_end', { value: 0.8, durationMs: Date.now() - S.holdStart }); S.holding = false; }
  };
  pad.addEventListener('pointerup', release); pad.addEventListener('pointercancel', release);
  pad.addEventListener('contextmenu', (e) => e.preventDefault());
  function feedback(e) { const r = document.createElement('div'), b = pad.getBoundingClientRect(); r.className = 'ring'; r.style.left = e.clientX - b.left + 'px'; r.style.top = e.clientY - b.top + 'px'; pad.appendChild(r); setTimeout(() => r.remove(), 500); }

  // Optional shake. Taps and holds are enough for a full session, so a missing or denied sensor changes nothing.
  if (typeof DeviceMotionEvent !== 'undefined') {
    $('motion').hidden = false;
    $('motion').onclick = async () => {
      try { if (typeof DeviceMotionEvent.requestPermission === 'function' && (await DeviceMotionEvent.requestPermission()) !== 'granted') throw 0; } catch { $('motion').hidden = true; return; }
      $('motion').hidden = true; let lp = 0;
      addEventListener('devicemotion', (e) => {
        const a = e.acceleration && e.acceleration.x !== null ? e.acceleration : null; if (!a) return;
        const m = Math.hypot(a.x, a.y, a.z); lp = 0.6 * lp + 0.4 * m;           // low-pass the magnitude
        if (lp > 12 && Date.now() - S.lastShake > 500) { S.lastShake = Date.now(); send('shake', { value: Math.min(1, lp / 30) }); navigator.vibrate && navigator.vibrate(20); }
      });
    };
  }
  try { navigator.wakeLock && navigator.wakeLock.request('screen').catch(() => {}); } catch {}     // best effort

  if (!code) { conn('bad', 'No room code'); set('instr', 'Scan the QR code on the host screen'); } else join().catch(() => { conn('bad', 'Cannot reach the host'); set('instr', 'Check you are on the same Wi-Fi as the host'); });
})();
