// Автотест чата с записью экрана: два "пользователя" в реальных браузерах-вкладках.
// Запуск: node test-chat.js   (сервер должен быть запущен)
// Нужен интерактивный браузер (Chrome/Edge). Выход: messenger/../recordings/chat-test.mp4
const { chromium } = require('playwright');

(async () => {
  const out = process.argv[2];
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: out, size: { width: 1280, height: 800 } },
  });

  const pageA = await ctx.newPage();
  await pageA.goto('http://localhost:8090');
  await pageA.evaluate(() => localStorage.setItem('chat.nick', 'Аня'));
  await pageA.reload();
  await pageA.waitForFunction(() => document.getElementById('conn').textContent === 'на связи');

  const pageB = await ctx.newPage();
  await pageB.goto('http://localhost:8090');
  await pageB.evaluate(() => localStorage.setItem('chat.nick', 'Борис'));
  await pageB.reload();
  await pageB.waitForFunction(() => document.getElementById('conn').textContent === 'на связи');

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const send = async (page, text) => {
    await page.fill('#input', text);
    await sleep(500);
    await page.press('#input', 'Enter');
    await sleep(900);
  };

  await pageA.bringToFront();
  await sleep(1200);

  await send(pageA, 'Привет! Смотри, локальный мессенджер работает');
  await pageB.bringToFront();
  await send(pageB, 'Привет Аня! Да, вижу сообщение в реальном времени');
  await pageA.bringToFront();
  await send(pageA, 'Ага, WebSocket без библиотек, на чистом Node');
  await pageB.bringToFront();
  // покажем индикатор "печатает"
  await pageB.fill('#input', 'Проверяю typing…');
  await sleep(1500);
  await pageA.bringToFront();
  await sleep(1500);
  await pageA.fill('#input', 'Вижу, что печатает 😄');
  await pageA.press('#input', 'Enter');
  await sleep(1200);
  await pageB.bringToFront();
  await pageB.fill('#input', '');
  await send(pageB, 'Записываю это на видео 🎥');
  await pageA.bringToFront();
  await sleep(1500);

  await ctx.close();
  await browser.close();
  const fs = require('fs');
  const path = require('path');
  const target = path.join(__dirname, '..', 'recordings', 'chat-test.mp4');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const vids = fs.readdirSync(out).filter(f => f.endsWith('.webm')).map(f => ({ f, t: fs.statSync(path.join(out, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  if (vids[0]) {
    const ff = await findFfmpeg();
    if (ff) {
      require('child_process').execFileSync(ff, ['-y', '-i', path.join(out, vids[0].f), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', target]);
      console.log('saved', target);
    } else {
      fs.copyFileSync(path.join(out, vids[0].f), target.replace(/\.mp4$/, '.webm'));
      console.log('saved', target.replace(/\.mp4$/, '.webm'));
    }
  }
  console.log('done');
})().catch(e => { console.error(e); process.exit(1); });

function findFfmpeg() {
  const { execSync } = require('child_process');
  try { return execSync('where ffmpeg', { encoding: 'utf8' }).split(/\r?\n/)[0].trim(); } catch (e) { return null; }
}
