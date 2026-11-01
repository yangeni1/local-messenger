// Мини-мессенджер: HTTP + WebSocket без зависимостей (Node 22).
// Локально: node server.js  →  http://localhost:8090
// Публично: задай CHAT_TOKEN (пароль на вход) и, при желании, PORT.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');

const PORT = Number(process.env.PORT) || 8090;
const HOST = process.env.HOST || '0.0.0.0';           // локально можно 127.0.0.1
const TOKEN_HASH = process.env.CHAT_TOKEN ? crypto.createHash('sha256').update(process.env.CHAT_TOKEN.trim()).digest('hex') : ''; // пароль храним только хешем
const ROOT = path.join(__dirname, 'public');
const HISTORY_LIMIT = 300;
const MAX_MSG = 2000;
const MAX_NICK = 20;

// простой rate limit: 10 сообщений / 10 секунд на соединение
const RL_WINDOW = 10000, RL_MAX = 10;

// ограничения: имя пользователя доступно только одному соединению, максимум соединений
const MAX_CONNECTIONS = 200;
const MAX_NICKS = 500;

const history = [];
const rooms = new Map();      // room -> Set<WS>
const nickOwner = new Map();  // nick -> WS

function colorFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${h}, 75%, 62%)`;
}

/* ---------------- HTTP ---------------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// режем всё, что не должно попасть в веб
const PUBLIC_ONLY = /\.(html|js|css|svg|ico)$/i;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'x-auth': TOKEN_HASH ? 'required' : 'open' });
    res.end('{"ok":true}');
    return;
  }

  if (url.pathname === '/api/state') {
    const room = url.searchParams.get('room') || 'main';
    const auth = url.searchParams.get('token') || '';
    if (TOKEN_HASH && auth !== TOKEN_HASH) { res.writeHead(401, { 'content-type': 'application/json', 'x-auth': 'required' }); res.end('{"error":"unauthorized"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-auth': TOKEN_HASH ? 'required' : 'open' });
    res.end(JSON.stringify({
      online: [...new Set([...rooms.values()].flatMap(s => [...s].map(w => w.nick).filter(Boolean)))],
      messages: history.filter(m => m.room === room).slice(-80).map(({ id, nick, color, text, ts }) => ({ id, nick, color, text, ts })),
      rooms: [...rooms.keys()],
    }));
    return;
  }

  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  try { p = decodeURIComponent(p); } catch (e) { res.writeHead(400); res.end('bad'); return; }
  p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(ROOT, p);

  // защита от выхода за пределы папки + белый список расширений
  if (!file.startsWith(ROOT + path.sep) || !PUBLIC_ONLY.test(file)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-auth': TOKEN_HASH ? 'required' : 'open',
      'referrer-policy': 'no-referrer',
    });
    res.end(buf);
  });
});

/* ---------------- WebSocket (RFC6455, минимум) ---------------- */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WS {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.nick = null;
    this.room = null;
    this.msgs = [];         // timestamps для rate limit
    this.challenge = null;
    socket.setNoDelay(true);
    socket.on('data', d => this._onData(d));
    socket.on('close', () => this._destroy());
    socket.on('error', () => this._destroy());
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; this.close(); return; }  // такие мы не шлём
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      const mask = masked ? this.buf.subarray(off, off + 4) : null;
      const data = Buffer.from(this.buf.subarray(off + maskLen, off + maskLen + len));
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + maskLen + len);

      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this._send(data, 0xA); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x1 || opcode === 0x2) {
        if (data.length > 64000) { this.close(); return; }
        try { onMessage(this, JSON.parse(data.toString('utf8'))); } catch (e) {}
      }
      // opcode 0x0 (continuation) — клиенты шлют короткие фреймы, игнорируем
    }
  }

  _send(payload, opcode = 0x1) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
    else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    head[0] = 0x80 | opcode;
    try { this.socket.write(Buffer.concat([head, payload])); } catch (e) { this._destroy(); }
  }

  send(obj) { this._send(Buffer.from(JSON.stringify(obj))); }
  close() { this._send(Buffer.alloc(0), 0x8); this._destroy(); }

  _destroy() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch (e) {}
    onClose(this);
  }
}

const allowedOrigin = origin => {
  if (!origin) return true;
  if (!TOKEN_HASH) return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return true; // при установленном пароле вход защищён паролем
};

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  if (!allowedOrigin(req.headers.origin)) { socket.destroy(); return; }
  if (nickOwner.size >= MAX_NICKS) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  // HTTPS-терминация на прокси (Render/Railway) — TLS не нужен; иначе, если задан TLS, оборачиваем
  if (process.env.TLS_KEY && process.env.TLS_CERT) {
    const s = new tls.TLSSocket(socket, { isServer: true, key: fs.readFileSync(process.env.TLS_KEY), cert: fs.readFileSync(process.env.TLS_CERT) });
    new WS(s);
  } else {
    new WS(socket);
  }
});

/* ---------------- чат ---------------- */

function joinRoom(ws, room) {
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(ws);
  ws.room = room;
}
function leaveRoom(ws) {
  const set = rooms.get(ws.room);
  if (set) { set.delete(ws); if (!set.size) rooms.delete(ws.room); }
}

const safeText = s => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, MAX_MSG).trim();
const safeNick = s => String(s ?? '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, MAX_NICK) || 'anon' + Math.floor(Math.random() * 1000);

function authOk(ws, proof) {
  if (!TOKEN_HASH) return true;
  if (typeof proof !== 'string' || !proof) return false;
  const candidate = /^[0-9a-f]{64}$/i.test(proof) ? proof.toLowerCase() : crypto.createHash('sha256').update(proof).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(TOKEN_HASH, 'hex')); } catch (e) { return false; }
}

function rateLimited(ws) {
  const now = Date.now();
  ws.msgs = ws.msgs.filter(t => now - t < RL_WINDOW);
  if (ws.msgs.length >= RL_MAX) return true;
  ws.msgs.push(now);
  return false;
}

function onMessage(ws, msg) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'join') {
    if (ws.nick) return;
    if (!authOk(ws, msg.proof)) { ws.send({ type: 'error', code: 'auth', text: 'неверный пароль' }); ws.close(); return; }
    let nick = safeNick(msg.nick);
    // ник уникален: иначе вживую видно только одного и можно писать от чужого имени
    if (nickOwner.has(nick)) nick = nick.slice(0, MAX_NICK - 3) + '_' + Math.floor(Math.random() * 90 + 10);
    ws.nick = nick;
    ws.color = colorFor(ws.nick);
    nickOwner.set(ws.nick, ws);
    joinRoom(ws, 'main');
    ws.send({ type: 'welcome', you: { nick: ws.nick, color: ws.color }, history: history.slice(-80) });
    broadcastAll({ type: 'system', text: `${ws.nick} зашёл`, ts: Date.now() });
    pushPresence();
    return;
  }

  if (!ws.nick) { ws.send({ type: 'error', text: 'сначала join' }); return; }

  if (msg.type === 'msg') {
    if (rateLimited(ws)) { ws.send({ type: 'error', text: 'слишком быстро' }); return; }
    const text = safeText(msg.text);
    if (!text) return;
    const m = { id: crypto.randomUUID(), nick: ws.nick, color: ws.color, text, ts: Date.now(), room: ws.room };
    history.push(m);
    if (history.length > HISTORY_LIMIT) history.shift();
    broadcastRoom(ws.room, { type: 'msg', msg: m });
    return;
  }

  if (msg.type === 'typing') {
    broadcastRoom(ws.room, { type: 'typing', nick: ws.nick, on: !!msg.on }, ws);
    return;
  }
}

function onClose(ws) {
  if (!ws.nick) return;
  leaveRoom(ws);
  if (nickOwner.get(ws.nick) === ws) nickOwner.delete(ws.nick);
  broadcastAll({ type: 'system', text: `${ws.nick} вышел`, ts: Date.now() });
  pushPresence();
}

function send(ws, obj) { if (!ws.closed) ws.send(obj); }
function broadcastRoom(room, obj, except) {
  const set = rooms.get(room);
  if (!set) return;
  for (const w of set) if (w !== except) send(w, obj);
}
function broadcastAll(obj) {
  for (const set of rooms.values()) for (const w of set) send(w, obj);
}
function pushPresence() {
  const online = [...new Set([...rooms.values()].flatMap(s => [...s].map(w => w.nick).filter(Boolean)))];
  broadcastAll({ type: 'presence', online });
}

// защита от медленных/злонамеренных соединений: 200 активных одновременно
server.maxConnections = MAX_CONNECTIONS;

// heartbeat
setInterval(() => {
  for (const set of rooms.values()) for (const w of set) {
    if (w.closed) continue;
    try { w._send(Buffer.alloc(0), 0x9); } catch (e) { w._destroy(); }
  }
}, 25000).unref();

// GC истории по никам при отключении — без накопления
setInterval(() => {
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
}, 60000).unref();

server.listen(PORT, HOST, () => {
  if (TOKEN_HASH && HOST === '0.0.0.0' && !process.env.RENDER && !process.env.RAILWAY_ENVIRONMENT) {
    console.warn('ВНИМАНИЕ: без TLS (http) хеш пароля уходит по сети открыто — используй только доверенную сеть.');
  }
  console.log(`мессенджер: http://localhost:${PORT} (${TOKEN_HASH ? 'вход по паролю' : 'открытый'})`);
});
