// Проверка публичного сервера: wss + пароль + обмен сообщением
const crypto = require('crypto');
const HOST = process.argv[2];
const PASS = process.argv[3];
const proof = crypto.createHash('sha256').update(PASS).digest('hex');

function mk(nick, proofStr) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`wss://${HOST}`);
    const got = [];
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', nick, proof: proofStr }));
    ws.onmessage = e => {
      const d = JSON.parse(e.data);
      got.push(d);
      if (d.type === 'welcome') res({ ws, got, me: d.you });
      if (d.type === 'error') res({ ws, got, err: d.text || d.code });
    };
    ws.onerror = e => rej(new Error('ws error'));
    setTimeout(() => rej(new Error('timeout')), 20000);
  });
}

(async () => {
  const a = await mk('Проверка1', proof);
  const b = await mk('Проверка2', proof);
  const bad = await mk('Злой', 'deadbeef'.repeat(8));
  a.ws.send(JSON.stringify({ type: 'msg', text: 'живой чат на Render 🚀' }));
  await new Promise(r => setTimeout(r, 1500));
  console.log(JSON.stringify({
    connect: !!a.me && !!b.me,
    nicks: [a.me?.nick, b.me?.nick],
    badAuthRejected: !!bad.err,
    delivered: b.got.some(d => d.type === 'msg' && d.msg.text.includes('живой чат')),
    presence: b.got.some(d => d.type === 'presence'),
  }, null, 2));
  a.ws.close(); b.ws.close();
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
