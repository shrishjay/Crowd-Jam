const test = require('node:test'), assert = require('node:assert');
const WebSocket = require('ws');
const { createServer } = require('../server/index');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const collect = (ws) => { const got = []; ws.on('message', (m) => got.push(JSON.parse(m))); return got; };
const open = (url) => new Promise((ok, no) => { const ws = new WebSocket(url); ws.on('open', () => ok(ws)); ws.on('error', no); ws.on('unexpected-response', (_, res) => no(new Error('HTTP ' + res.statusCode))); });
const post = (base, path, body, tok) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body || {}) }).then(async (r) => ({ status: r.status, body: await r.json() }));

test('full vertical slice: create -> QR -> join -> gesture -> ack -> host event -> rounds -> end -> export', async (t) => {
  const app = createServer({ timeScale: 0.12 }); const port = await app.listen(0), base = `http://127.0.0.1:${port}`, ws = `ws://127.0.0.1:${port}`;
  t.after(() => app.close());

  const room = (await post(base, '/api/rooms', { preset: 'CINEMATIC' })).body;
  assert.ok(room.qr.startsWith('<svg') && room.joinUrl.includes('/join/' + room.joinCode) && room.hostToken);
  const page = await (await fetch(base + '/join/' + room.joinCode)).text();
  assert.ok(page.includes('CrowdSynth'), 'participant page is served on the join URL');
  for (const src of [...page.matchAll(/src="([^"]+)"/g)].map((m) => m[1])) {   // regression: a relative src under /join/ used to load HTML instead of JS
    assert.ok(src.startsWith('/'), 'script src must be absolute: ' + src);
    const r = await fetch(base + src); assert.ok((r.headers.get('content-type') || '').includes('javascript'), src + ' must be served as JavaScript');
  }

  const host = await open(`${ws}/ws?roomId=${room.roomId}&clientType=host&token=${room.hostToken}`), hostMsgs = collect(host);
  await assert.rejects(open(`${ws}/ws?roomId=${room.roomId}&clientType=host&token=wrong`), /401/);
  await assert.rejects(open(`${ws}/ws?roomId=${room.roomId}&clientType=participant&token=nope`), /401/);

  const joins = []; for (let i = 0; i < 12; i++) joins.push((await post(base, `/api/rooms/${room.joinCode}/join`)).body);
  assert.ok(joins.every((j) => j.token && j.snapshot.type === 'snapshot'));
  const socks = []; for (const j of joins) { const s = await open(`${ws}/ws?roomId=${room.roomId}&clientType=participant&token=${j.token}`); socks.push({ s, got: collect(s), seq: 0 }); }
  await wait(100);
  assert.equal(hostMsgs.at(-1).participants, 12);

  // gestures before start are rejected, never produce sound
  socks[0].s.send(JSON.stringify({ type: 'gesture', inputId: 'tap', clientSequence: 1, value: 0.5 })); await wait(80);
  assert.equal(socks[0].got.find((m) => m.type === 'gesture_ack').reason, 'NOT_RUNNING');

  assert.equal((await post(base, `/api/rooms/${room.roomId}/start`, {}, 'bad')).status, 401);
  assert.equal((await post(base, `/api/rooms/${room.roomId}/start`, { preset: 'CINEMATIC' }, room.hostToken)).body.status, 'RUNNING');
  await wait(1700);                                                    // lead-in

  // every participant taps now and then for the whole session; fire shakes/holds too
  const rounds = new Set(), t0 = Date.now(); let ended = false;
  const driver = setInterval(() => socks.forEach((x, i) => { if (ended) return; x.seq++; x.s.send(JSON.stringify({ type: 'gesture', inputId: ['tap', 'tap', 'hold_end', 'shake'][(x.seq + i) % 4], clientSequence: x.seq, value: 0.7, durationMs: 900 })); }), 400);
  t.after(() => clearInterval(driver));
  await wait(900);
  const acks = socks.flatMap((x) => x.got.filter((m) => m.type === 'gesture_ack' && m.clientSequence > 1));
  assert.ok(acks.some((a) => a.accepted && a.eventId), 'accepted ack with eventId');
  assert.ok(hostMsgs.some((m) => m.type === 'musical_event' && m.event.source === 'PARTICIPANT'), 'participant gesture became a host event');
  const ev = hostMsgs.filter((m) => m.type === 'musical_event').map((m) => m.event);
  assert.ok(ev.every((e, i) => i === 0 || e.sequence > ev[i - 1].sequence), 'server sequence strictly increases');

  host.send(JSON.stringify({ type: 'host_control', action: 'advance_round' }));
  for (let i = 0; i < 400 && !hostMsgs.some((m) => m.status === 'COMPLETE'); i++) { hostMsgs.filter((m) => m.round).forEach((m) => rounds.add(m.round)); if (i === 150) host.send(JSON.stringify({ type: 'host_control', action: 'end' })); await wait(100); }
  ended = true;
  assert.ok(hostMsgs.some((m) => m.status === 'FINALIZING'), 'finalizing state');
  assert.ok(hostMsgs.some((m) => m.status === 'COMPLETE'), 'complete state');
  assert.ok(rounds.size >= 2, 'rounds advanced: ' + [...rounds]);
  // participants were told their role changed on round change
  assert.ok(new Set(socks[0].got.filter((m) => m.role).map((m) => m.round)).size >= 2);

  const exp = await (await fetch(`${base}/api/rooms/${room.roomId}/export`, { headers: { authorization: 'Bearer ' + room.hostToken } })).json();
  assert.ok(exp.events.length > 50 && exp.metadata.seed && exp.metadata.tempoBpm === 92);
  assert.equal((await fetch(`${base}/api/rooms/${room.roomId}/export`)).status, 401);
});

test('flood from one socket is rate limited; oversize + unknown messages are rejected', async (t) => {
  const app = createServer({ timeScale: 0.2 }); const port = await app.listen(0), base = `http://127.0.0.1:${port}`, ws = `ws://127.0.0.1:${port}`;
  t.after(() => app.close());
  const room = (await post(base, '/api/rooms')).body, j = (await post(base, `/api/rooms/${room.joinCode}/join`)).body;
  const s = await open(`${ws}/ws?roomId=${room.roomId}&clientType=participant&token=${j.token}`), got = collect(s);
  await post(base, `/api/rooms/${room.roomId}/start`, {}, room.hostToken); await wait(1700);
  for (let i = 1; i <= 40; i++) s.send(JSON.stringify({ type: 'gesture', inputId: 'tap', clientSequence: i, value: 0.5 }));
  s.send(JSON.stringify({ type: 'make_noise', pitch: 99 })); await wait(300);
  const acks = got.filter((m) => m.type === 'gesture_ack');
  assert.ok(acks.filter((a) => a.accepted).length <= 8 && acks.some((a) => a.reason === 'RATE_LIMITED' || a.reason === 'DUPLICATE'));
  assert.ok(got.some((m) => m.type === 'error'));
  s.send('x'.repeat(5000)); await wait(200); assert.notEqual(s.readyState, WebSocket.OPEN, 'payloads over 4 KB close the socket');
});
