'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const { RoomManager, send } = require('./rooms');
const { parse, validateHostControl } = require('./protocol');
const { candidates } = require('./network');

const PUB = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const json = (res, code, body) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer /, '');

function createServer(opts = {}) {
  const mgr = new RoomManager({ timeScale: opts.timeScale || 1, maxParticipants: Number(process.env.MAX_PARTICIPANTS) || 30 });
  const state = { port: opts.port || Number(process.env.PORT) || 3000 };
  const baseFor = (ip) => process.env.PUBLIC_BASE_URL || `http://${ip}:${state.port}`;
  const bestIp = () => (candidates()[0] || { ip: 'localhost' }).ip;
  const joinInfo = async (room, ip) => { const joinUrl = `${baseFor(ip)}/join/${room.code}`; return { joinUrl, qr: await QRCode.toString(joinUrl, { type: 'svg', margin: 1 }) }; };

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://x'), parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === 'api') {
        let body = {};
        if (req.method === 'POST') { let s = ''; for await (const c of req) { s += c; if (s.length > 4096) return json(res, 413, { error: 'too large' }); } try { body = s ? JSON.parse(s) : {}; } catch { return json(res, 400, { error: 'bad json' }); } }
        if (u.pathname === '/api/network') return json(res, 200, { candidates: candidates(), selected: bestIp() });
        if (u.pathname === '/api/rooms' && req.method === 'POST') {
          const room = mgr.create(body.preset), ip = bestIp();
          return json(res, 200, { roomId: room.id, joinCode: room.code, hostToken: room.hostToken, ...(await joinInfo(room, ip)), ip, candidates: candidates() });
        }
        if (parts[1] === 'rooms' && parts[2]) {
          if (parts.length === 3 && req.method === 'GET') { const r = mgr.byCode(parts[2]); return r ? json(res, 200, { code: r.code, status: r.status, participants: r.connected().length, preset: r.config.preset }) : json(res, 404, { error: 'no such room' }); }
          if (parts[3] === 'join' && req.method === 'POST') {
            const r = mgr.byCode(parts[2]); if (!r) return json(res, 404, { error: 'no such room' });
            try { const { p, token } = r.join(); return json(res, 200, { participantId: p.id, token, alias: p.alias, snapshot: r.participantState(p, 'snapshot') }); }
            catch (e) { return json(res, e.code || 500, { error: e.message }); }
          }
          const r = mgr.byId(parts[2]);                     // everything below is host-only
          if (!r || !r.authHost(bearer(req))) return json(res, 401, { error: 'unauthorized' });
          const act = parts[3];
          if (req.method === 'POST' && ['start', 'pause', 'resume', 'end'].includes(act)) { const ok = act === 'start' ? r.start(body.preset) : r[act](); return json(res, ok ? 200 : 409, { ok, status: r.status }); }
          if (req.method === 'POST' && act === 'address') {
            const c = candidates().find((x) => x.ip === body.ip); if (!c) return json(res, 400, { error: 'unknown address' });
            return json(res, 200, await joinInfo(r, c.ip));
          }
          if (req.method === 'GET' && act === 'export') return json(res, 200, r.exportData());
        }
        return json(res, 404, { error: 'not found' });
      }
      // static: /join/CODE serves the participant page; / serves the host page
      let rel = u.pathname === '/' ? '/host.html' : parts[0] === 'join' ? '/play.html' : u.pathname;
      const file = path.normalize(path.join(PUB, rel));
      if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
      res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream'); res.setHeader('cache-control', 'no-store');
      fs.createReadStream(file).pipe(res);
    } catch (e) { json(res, 500, { error: 'server error' }); }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (req, sock, head) => {
    const u = new URL(req.url, 'http://x'), q = u.searchParams, room = mgr.byId(q.get('roomId')), tok = q.get('token') || '', type = q.get('clientType');
    const who = !room || u.pathname !== '/ws' ? null : type === 'host' ? (room.authHost(tok) ? { host: true } : null) : type === 'participant' ? (room.authParticipant(tok) ? { p: room.authParticipant(tok) } : null) : null;
    if (!who) { sock.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return sock.destroy(); }
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws, room, who));
  });
  wss.on('connection', (ws, room, who) => {
    if (who.host) room.attachHost(ws); else room.attachParticipant(who.p, ws);
    ws.on('message', (raw) => {
      const m = parse(raw.toString());
      if (who.p) who.p.lastSeenAt = Date.now();
      if (!m) return send(ws, { type: 'error', reason: 'BAD_SCHEMA' });
      if (m.type === 'ping') return send(ws, { type: 'pong', clientTimeMs: m.clientTimeMs, serverTimeMs: Date.now() });
      if (who.p && m.type === 'gesture') return send(ws, room.handleGesture(who.p, m));
      if (who.host && m.type === 'host_control') {
        const c = validateHostControl(m); if (!c) return send(ws, { type: 'error', reason: 'BAD_SCHEMA' });
        const a = c.action; const ok = a === 'start' ? room.start(c.preset) : a === 'advance_round' ? room.advance() : a === 'set_master_volume' ? true : room[a]();
        return send(ws, { type: 'control_ack', action: a, ok, status: room.status });
      }
      send(ws, { type: 'error', reason: 'BAD_SCHEMA' });                       // unknown message types are rejected
    });
    ws.on('close', () => { if (who.p) room.detachParticipant(who.p, ws); else if (room.hostWs === ws) room.hostWs = null; });
    ws.on('error', () => {});
  });

  const timer = setInterval(() => mgr.tick(), 40);
  return {
    server, mgr, state,
    listen: (port = state.port) => new Promise((ok) => server.listen(port, '0.0.0.0', () => { state.port = server.address().port; ok(state.port); })),
    close: () => { clearInterval(timer); wss.clients.forEach((c) => c.terminate()); return new Promise((ok) => server.close(ok)); },
  };
}

if (require.main === module) {
  const app = createServer();
  app.listen().then((port) => {
    console.log(`\nCrowdSynth host screen:  http://localhost:${port}`);
    const c = candidates();
    console.log('Phones must reach one of these (same Wi-Fi):'); c.forEach((x) => console.log(`  ${x.virtual ? '(virtual, probably not reachable) ' : ''}http://${x.ip}:${port}   [${x.name}]`));
    if (!c.length) console.log('  none found - connect to Wi-Fi or a hotspot');
  });
}
module.exports = { createServer };
