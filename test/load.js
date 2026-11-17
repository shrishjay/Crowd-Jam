// Load test (blueprint 19.4): 30 phones join one room and tap at realistic rates for 20 s, then a short abuse burst.
// Usage: npm run load   (starts its own server on a random port)
const WebSocket = require('ws');
const { createServer } = require('../server/index');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const app = createServer({ timeScale: 0.5 }), port = await app.listen(0), base = `http://127.0.0.1:${port}`;
  const post = (p, b, t) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: JSON.stringify(b || {}) }).then((r) => r.json());
  const room = await post('/api/rooms'), host = new WebSocket(`ws://127.0.0.1:${port}/ws?roomId=${room.roomId}&clientType=host&token=${room.hostToken}`);
  let events = 0, maxLag = 0; host.on('message', (m) => { const d = JSON.parse(m); if (d.type === 'musical_event') events++; });
  await new Promise((r) => host.on('open', r));
  const clients = [];
  for (let i = 0; i < 30; i++) {
    const j = await post(`/api/rooms/${room.joinCode}/join`), ws = new WebSocket(`ws://127.0.0.1:${port}/ws?roomId=${room.roomId}&clientType=participant&token=${j.token}`), c = { ws, seq: 0, acc: 0, rej: {} };
    ws.on('message', (m) => { const d = JSON.parse(m); if (d.type === 'gesture_ack') d.accepted ? c.acc++ : (c.rej[d.reason] = (c.rej[d.reason] || 0) + 1); });
    await new Promise((r) => ws.on('open', r)); clients.push(c);
  }
  await post(`/api/rooms/${room.roomId}/start`, {}, room.hostToken); await wait(1700);
  const fire = (c, id) => { c.seq++; c.ws.send(JSON.stringify({ type: 'gesture', inputId: id, clientSequence: c.seq, value: Math.random() })); };
  const t0 = Date.now(), loop = setInterval(() => clients.forEach((c) => fire(c, Math.random() < 0.85 ? 'tap' : 'shake')), 1000);   // normal use: ~1 gesture/s each
  await wait(20000); clearInterval(loop);
  const normal = clients.reduce((s, c) => s + c.acc, 0), n0 = events;
  const abuse = setInterval(() => clients.slice(0, 5).forEach((c) => fire(c, 'tap')), 5); await wait(2000); clearInterval(abuse); await wait(500);
  const rej = {}; clients.forEach((c) => Object.entries(c.rej).forEach(([k, v]) => (rej[k] = (rej[k] || 0) + v)));
  const tick = process.hrtime.bigint(); await wait(0); const lag = Number(process.hrtime.bigint() - tick) / 1e6;
  console.log({ clients: clients.length, secs: (Date.now() - t0) / 1000, acceptedNormalUse: normal, hostEvents: events, eventsDuringAbuse: events - n0, rejectedByReason: rej, loopLagMs: +lag.toFixed(2), room: app.mgr.byId(room.roomId).status });
  clients.forEach((c) => c.ws.close()); host.close(); await app.close(); process.exit(0);
})();
