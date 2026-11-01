// Диагностика WS на Render: подробности ошибки + сырой HTTP upgrade
const HOST = process.argv[2];
const https = require('https');
const crypto = require('crypto');

const key = crypto.randomBytes(16).toString('base64');
const req = https.request({
  host: HOST, port: 443, path: '/', method: 'GET',
  headers: {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': key,
    Origin: `https://${HOST}`,
  },
});
req.on('upgrade', (res, socket) => {
  console.log('UPGRADE OK', res.statusCode, res.headers['sec-websocket-accept']);
  socket.destroy();
  process.exit(0);
});
req.on('response', res => {
  console.log('RESPONSE (не upgrade):', res.statusCode, JSON.stringify(res.headers));
  process.exit(1);
});
req.on('error', e => { console.log('ERR', e.code, e.message); process.exit(1); });
req.setTimeout(25000, () => { console.log('TIMEOUT'); req.destroy(); process.exit(1); });
req.end();
