// Room server: hands out rooms + QR codes, assigns each phone an instrument, relays taps to the host screen.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000, PUB = path.join(__dirname, 'public');
const ROLES = ['lead', 'drums', 'bass', 'arp', 'pad', 'lead', 'drums', 'arp']; // assigned round-robin as people join
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const rooms = new Map();

const lanIp = () => Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal)?.address || 'localhost';
const send = (ws, m) => ws && ws.readyState === 1 && ws.send(JSON.stringify(m));
const code = () => Array.from({ length: 4 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ'[Math.floor(Math.random() * 23)]).join('');

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/room') {
    if (rooms.size > 50) rooms.delete(rooms.keys().next().value);
    let c; do c = code(); while (rooms.has(c));
    rooms.set(c, { host: null, players: new Set(), ids: 0, phase: 'wait' });
    const url = `${process.env.BASE_URL || `http://${lanIp()}:${PORT}`}/play.html?room=${c}`;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ room: c, url, qr: await QRCode.toString(url, { type: 'svg', margin: 1 }) }));
  }
  const file = path.join(PUB, u.pathname === '/' ? 'host.html' : u.pathname);
  if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/ws') return sock.destroy();
  wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws, u));
});

wss.on('connection', (ws, u) => {
  const room = rooms.get(u.searchParams.get('room'));
  if (!room) return ws.close();
  if (u.searchParams.get('as') === 'host') {
    room.host = ws;
    ws.on('message', (m) => { // host announces phase: play | done
      try { const d = JSON.parse(m); if (d.t === 'phase') { room.phase = d.v; room.players.forEach((p) => send(p, d)); } } catch {}
    });
    return;
  }
  const id = ++room.ids, role = ROLES[(id - 1) % ROLES.length];
  let tok = 5, last = Date.now();   // first-line flood guard: 10 msgs/sec, burst 5
  room.players.add(ws);
  send(ws, { t: 'hello', role, phase: room.phase });
  send(room.host, { t: 'join', id, role });
  ws.on('message', (m) => {
    const now = Date.now(); tok = Math.min(5, tok + (now - last) * 0.01); last = now;
    if (tok < 1 || room.phase !== 'play') return;
    tok--;
    try { const d = JSON.parse(m); if (typeof d.x === 'number') send(room.host, { t: 'in', id, role, x: d.x, y: d.y }); } catch {}
  });
  ws.on('close', () => { room.players.delete(ws); send(room.host, { t: 'leave', id, role }); });
});

server.listen(PORT, () => console.log(`Host screen: http://localhost:${PORT}  (phones join via the QR on that page; same Wi-Fi)`));
