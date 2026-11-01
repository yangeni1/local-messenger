// Проверка WebSocket-пути: пароль, уникальность ников, rate limit. Без браузера.
// node check-ws.js <порт> <пароль>
const crypto = require('crypto');
const [port = 8090, pass = ''] = process.argv.slice(2);
const url = `ws://localhost:${port}`;
const proof = pass ? crypto.createHash('sha256').update(pass).digest('hex') : '';

function client(nick, p = proof) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const got = [];
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', nick, proof: p }));
    ws.onmessage = e => { const d = JSON.parse(e.data); got.push(d); if (d.type === 'welcome' || (d.type === 'error')) resolve({ ws, got, me: d.you, err: d.error || d.text }); };
    ws.onerror = () => reject(new Error('ws error'));
    setTimeout(() => reject(new Error('timeout')), 4000);
  });
}

(async () => {
  const a = await client('Борис');
  const b = await client('Борис');
  const bad = await client('Хакер', 'f'.repeat(64));
  const out = {
    aNick: a.me && a.me.nick,
    bNick: b.me && b.me.nick,
    unique: a.me && b.me && a.me.nick !== b.me.nick,
    badAuthClosed: !!bad.err,
  };
  // rate limit: шлём 15 сообщений подряд
  for (let i = 0; i < 15; i++) a.ws.send(JSON.stringify({ type: 'msg', text: 'spam ' + i }));
  await new Promise(r => setTimeout(r, 400));
  out.rateLimited = a.got.some(d => d.type === 'error');
  a.ws.close(); b.ws.close();
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.unique && out.badAuthClosed && out.rateLimited ? 0 : 1);
})().catch(e => { console.error(e.message); process.exit(1); });
