// Проверка публичного WS через локальный HTTP-прокси (127.0.0.1:10809), т.к. прямое TLS с этой машины режется.
// node check-public-proxy.js <host> <пароль> [прокси]
const net = require('net');
const tls = require('tls');
const http = require('http');
const crypto = require('crypto');

const [HOST, PASS, PROXY = '127.0.0.1:10809'] = process.argv.slice(2);
const [phost, pport] = PROXY.split(':');
const proof = PASS ? crypto.createHash('sha256').update(PASS).digest('hex') : '';

function tunnel() {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: phost, port: +pport, method: 'CONNECT', path: `${HOST}:443` });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error('proxy CONNECT ' + res.statusCode));
      resolve(socket);
    });
    req.on('error', reject);
    req.end();
  });
}

// минимальный WS-клиент поверх готового сокета
class Client {
  constructor(sock) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.handlers = [];
    sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this._parse(); });
  }
  _parse() {
    while (this.buf.length >= 2) {
      const b1 = this.buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      const opcode = this.buf[0] & 0x0f;
      this.buf = this.buf.subarray(off + len);
      if (opcode === 0x1) { try { this.handlers.forEach(h => h(JSON.parse(payload.toString()))); } catch (e) {} }
    }
  }
  onMessage(h) { this.handlers.push(h); }
  send(obj) {
    const data = Buffer.from(JSON.stringify(obj));
    const mask = crypto.randomBytes(4);
    let head;
    if (data.length < 126) { head = Buffer.alloc(2); head[1] = 0x80 | data.length; }
    else { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(data.length, 2); }
    head[0] = 0x81;
    const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    this.sock.write(Buffer.concat([head, mask, masked]));
  }
}

async function connect(nick, proofOverride) {
  const raw = await tunnel();
  const sock = tls.connect({ socket: raw, servername: HOST, ALPNProtocols: ['http/1.1'] });
  await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
  const key = crypto.randomBytes(16).toString('base64');
  sock.write(
    `GET / HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: https://${HOST}\r\n\r\n`
  );
  await new Promise((res, rej) => {
    const onData = d => {
      const s = d.toString('latin1');
      if (s.includes('\r\n\r\n')) {
        sock.removeListener('data', onData);
        if (!/101/.test(s.split('\r\n')[0])) return rej(new Error('handshake: ' + s.split('\r\n')[0]));
        if (d.length > s.indexOf('\r\n\r\n') + 4) sock.unshift(d.subarray(s.indexOf('\r\n\r\n') + 4));
        res();
      }
    };
    sock.on('data', onData);
    sock.once('error', rej);
    setTimeout(() => rej(new Error('handshake timeout')), 20000);
  });
  const c = new Client(sock);
  const events = [];
  const welcome = new Promise((res, rej) => {
    c.onMessage(m => { events.push(m); if (m.type === 'welcome') res(m); if (m.type === 'error') res({ err: m.text || m.code }); });
    setTimeout(() => rej(new Error('welcome timeout')), 20000);
  });
  c.send({ type: 'join', nick, proof: proofOverride ?? proof });
  const w = await welcome;
  return { c, events, welcome: w };
}

(async () => {
  const t0 = Date.now();
  const a = await connect('Проверка1');
  const b = await connect('Проверка2');
  b.c.send({ type: 'msg', text: 'живой чат на Render 🚀' });
  await new Promise(r => setTimeout(r, 1500));
  const bad = await connect('Злой', 'deadbeef'.repeat(8)).catch(e => ({ welcome: { err: e.message } }));
  const out = {
    connect: !a.welcome.err && !b.welcome.err,
    nicks: [a.welcome.you?.nick, b.welcome.you?.nick],
    delivered: a.events.some(m => m.type === 'msg' && m.msg.text.includes('живой чат')),
    presence: a.events.some(m => m.type === 'presence'),
    badAuthRejected: !!bad.welcome?.err,
    ms: Date.now() - t0,
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.connect && out.delivered && out.badAuthRejected ? 0 : 1);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
