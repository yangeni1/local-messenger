(() => {
  const $ = s => document.querySelector(s);
  const logEl = $('#log'), form = $('#form'), input = $('#input'), sendBtn = $('#send');
  const onlineEl = $('#online'), onlineCount = $('#onlineCount'), typingEl = $('#typing'), connEl = $('#conn');
  const meNick = $('#meNick'), avatar = $('#avatar');
  const menuBtn = $('#menuBtn'), closeSide = $('#closeSide'), backdrop = $('#backdrop'), headCount = $('#headCount');

  let ws = null, me = null, retry = 400, typingTimer = null, lastTypingSent = 0;
  const typing = new Map(); // nick -> ts

  /* ---------------- меню-шторка (телефон) ---------------- */
  const isMobile = () => matchMedia('(max-width: 720px)').matches;

  function setMenu(open) {
    document.body.classList.toggle('menu-open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
    if (isMobile()) $('#side').setAttribute('aria-hidden', String(!open));
  }
  function closeMenu() { setMenu(false); }

  menuBtn.addEventListener('click', () => setMenu(!document.body.classList.contains('menu-open')));
  closeSide.addEventListener('click', closeMenu);
  backdrop.addEventListener('click', closeMenu);
  addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (document.body.classList.contains('menu-open')) closeMenu();
    else if (!$('#renameBox').hidden) $('#renameBox').hidden = true;
  });
  addEventListener('resize', () => { if (!isMobile()) { document.body.classList.remove('menu-open'); $('#side').removeAttribute('aria-hidden'); } });
  if (isMobile()) $('#side').setAttribute('aria-hidden', 'true');

  // свайп от левого края — открыть, свайп влево по панели — закрыть
  let touchX = 0, touchY = 0;
  addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    touchX = e.touches[0].clientX;
    touchY = e.touches[0].clientY;
  }, { passive: true });
  addEventListener('touchend', e => {
    if (!isMobile() || e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - touchX;
    const dy = e.changedTouches[0].clientY - touchY;
    if (Math.abs(dx) < 55 || Math.abs(dy) > 70) return;
    const open = document.body.classList.contains('menu-open');
    if (!open && dx > 0 && touchX <= 30) setMenu(true);
    else if (open && dx < 0) setMenu(false);
  }, { passive: true });

  /* --- пароль на вход (если сервер требует) --- */
  function askPassword(message) {
    return new Promise(resolve => {
      const box = document.getElementById('login');
      const frm = document.getElementById('loginForm');
      const inp = document.getElementById('loginPass');
      const err = document.getElementById('loginErr');
      err.textContent = message || '';
      box.hidden = false;
      setTimeout(() => inp.focus(), 50);
      frm.addEventListener('submit', function onSub(e) {
        e.preventDefault();
        const v = inp.value;
        if (!v) return;
        frm.removeEventListener('submit', onSub);
        box.hidden = true;
        inp.value = '';
        resolve(v);
      });
    });
  }

  async function proofFromPass(pass) {
    if (!pass) return '';
    if (window.crypto?.subtle) {
      // в браузере не храним и не шлём пароль открытым текстом — только SHA-256
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pass));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    return pass; // http без crypto.subtle: сервер захеширует сам
  }

  async function deriveProof() {
    const r = await fetch('/api/health', { cache: 'no-store' }).catch(() => null);
    if (!r) return null;
    const needAuth = r.headers.get('x-auth') === 'required';
    if (!needAuth) return { proof: '' };
    let pass = sessionStorage.getItem('chat.pass');
    if (!pass) {
      pass = await askPassword('');
      sessionStorage.setItem('chat.pass', pass);
    }
    return { proof: await proofFromPass(pass) };
  }

  async function connectAsync() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    setConn('подключение…', '');
    const proof = await deriveProof();
    if (proof === null) { setConn('сервер недоступен, переподключение…', 'bad'); setTimeout(connectAsync, 3000); return; }
    if (proof.proof === null) return; // отменили ввод пароля
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => {
      retry = 400;
      ws.send(JSON.stringify({ type: 'join', nick: storedNick(), proof: proof.proof }));
    };
    ws.onmessage = e => {
      const data = JSON.parse(e.data);
      if (data.type === 'error' && data.code === 'auth') {
        sessionStorage.removeItem('chat.pass');
        setConn('неверный пароль', 'bad');
        askPassword('Неверный пароль, попробуйте ещё раз').then(() => { retry = 400; connectAsync(); });
        return;
      }
      handle(data);
    };
    ws.onclose = ev => { if (ev.code === 1000) return; setConn('нет связи, переподключение…', 'bad'); setTimeout(connectAsync, retry); retry = Math.min(retry * 2, 8000); };
    ws.onerror = () => {};
  }
  function connect() { connectAsync(); }

  function storedNick() {
    let n = localStorage.getItem('chat.nick');
    if (!n) {
      n = 'гость' + Math.floor(100 + Math.random() * 900);
      localStorage.setItem('chat.nick', n);
    }
    return n;
  }

  function setConn(text, cls) { connEl.textContent = text; connEl.className = 'conn ' + (cls || ''); }

  function handle(data) {
    switch (data.type) {
      case 'welcome':
        me = data.you;
        setConn('на связи', 'ok');
        meNick.textContent = me.nick;
        avatar.textContent = me.nick[0].toUpperCase();
        avatar.style.background = me.color;
        logEl.innerHTML = '';
        for (const m of data.history) addMessage(m, false);
        scrollDown();
        break;
      case 'msg': addMessage(data.msg, true); notifyIncoming(data.msg); break;
      case 'system': addSystem(data.text); break;
      case 'presence': renderOnline(data.online); break;
      case 'typing': if (data.nick === me?.nick) break; typing.set(data.nick, data.on ? Date.now() : 0); renderTyping(); break;
    }
  }

  function scrollDown() { logEl.scrollTop = logEl.scrollHeight; }

  /* ---------------- уведомления ---------------- */
  const notifBtn = $('#notifBtn');
  let unread = 0, audioCtx = null;
  let notifyPref = localStorage.getItem('chat.notify') !== 'off';

  const canNotify = () => 'Notification' in window && window.isSecureContext;

  function updateTitle() {
    document.title = unread > 0 ? `(${unread}) Мессенджер` : 'Мессенджер';
  }
  function clearUnread() { unread = 0; updateTitle(); }

  function beep(strong) {
    if (!notifyPref) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const t0 = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(strong ? 880 : 660, t0);
      osc.frequency.exponentialRampToValueAtTime(strong ? 1320 : 520, t0 + 0.12);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0); osc.stop(t0 + 0.3);
    } catch (e) {}
  }

  function flashTitle() {
    if (!notifyPref || !document.hidden) return;
    let on = false;
    clearInterval(flashTitle.timer);
    flashTitle.timer = setInterval(() => {
      on = !on;
      document.title = on ? '💬 Новое сообщение' : (unread ? `(${unread}) Мессенджер` : 'Мессенджер');
    }, 1200);
  }
  function stopFlash() { clearInterval(flashTitle.timer); updateTitle(); }

  function notifyIncoming(m) {
    if (!m || (me && m.nick === me.nick)) return;
    const mentioned = me && new RegExp('@' + me.nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(m.text);
    const away = document.hidden || !document.hasFocus();

    if (away || mentioned) {
      unread++;
      updateTitle();
      flashTitle();
      beep(!!mentioned);
    }
    if (!notifyPref || !canNotify() || Notification.permission !== 'granted') return;
    if (!away && !mentioned) return;

    try {
      const n = new Notification(mentioned ? `${m.nick} упомянул(а) тебя` : `${m.nick} — Мессенджер`, {
        body: m.text.slice(0, 180),
        tag: 'chat-' + m.nick,
        silent: true,
        icon: '/icon.svg',
      });
      n.onclick = () => { window.focus(); n.close(); clearUnread(); stopFlash(); };
      setTimeout(() => n.close(), 8000);
    } catch (e) {}
  }

  async function enableNotifications() {
    if (!canNotify()) {
      notifBtn.textContent = '🔔 Уведомления недоступны';
      notifBtn.disabled = true;
      notifBtn.title = 'Нужен https или localhost';
      return;
    }
    if (Notification.permission === 'granted') {
      notifyPref = !notifyPref;
      localStorage.setItem('chat.notify', notifyPref ? 'on' : 'off');
      renderNotifBtn();
      return;
    }
    const res = await Notification.requestPermission();
    if (res === 'granted') {
      notifyPref = true;
      localStorage.setItem('chat.notify', 'on');
      // пробное уведомление, чтобы пользователь увидел, что всё работает
      try { new Notification('Уведомления включены', { body: 'Придёт сообщение — я покажу.', icon: '/icon.svg' }); } catch (e) {}
      beep(true);
    }
    renderNotifBtn();
  }

  function renderNotifBtn() {
    if (!canNotify()) {
      notifBtn.textContent = '🔕 Уведомления недоступны';
      notifBtn.disabled = true;
      return;
    }
    const granted = Notification.permission === 'granted';
    notifBtn.textContent = !granted ? '🔔 Включить уведомления'
      : notifyPref ? '🔔 Уведомления вкл' : '🔕 Уведомления выкл';
    notifBtn.classList.toggle('off', granted && !notifyPref);
  }

  addEventListener('focus', () => { clearUnread(); stopFlash(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearUnread(); stopFlash(); } });
  notifBtn.addEventListener('click', enableNotifications);
  renderNotifBtn();
  updateTitle();

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  function addMessage(m, live) {
    const mine = me && m.nick === me.nick;
    const mentioned = !mine && me && new RegExp('@' + me.nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(m.text);
    const el = document.createElement('div');
    el.className = 'msg' + (mine ? ' mine' : '') + (mentioned ? ' mention' : '');
    const av = document.createElement('div');
    av.className = 'avatar';
    av.textContent = m.nick[0].toUpperCase();
    av.style.background = m.color;
    const body = document.createElement('div');
    body.className = 'body';
    const head = document.createElement('div');
    head.className = 'head';
    const b = document.createElement('b'); b.textContent = m.nick; b.style.color = mine ? '' : m.color;
    const time = document.createElement('time'); time.textContent = fmtTime(m.ts);
    head.append(b, time);
    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = m.text;   // только textContent — XSS невозможен
    body.append(head, text);
    el.append(av, body);
    logEl.appendChild(el);
    if (live) scrollDown();
  }

  function addSystem(text) {
    const el = document.createElement('div');
    el.className = 'sys';
    el.textContent = text;
    logEl.appendChild(el);
    scrollDown();
  }

  function renderOnline(list) {
    onlineEl.innerHTML = '';
    onlineCount.textContent = list.length;
    headCount.textContent = list.length;
    for (const nick of list) {
      const li = document.createElement('li');
      const d = document.createElement('span'); d.className = 'dot'; d.style.background = '#4ade80';
      const t = document.createElement('span'); t.textContent = nick === me?.nick ? nick + ' (ты)' : nick;
      li.append(d, t);
      if (nick !== me?.nick) {
        li.classList.add('tap');
        li.title = `Упомянуть @${nick}`;
        li.addEventListener('click', () => {
          const tag = `@${nick} `;
          input.value = input.value && !input.value.endsWith(' ') ? input.value + ' ' + tag : input.value + tag;
          autoGrow();
          closeMenu();
          input.focus();
        });
      }
      onlineEl.appendChild(li);
    }
  }

  function renderTyping() {
    const now = Date.now();
    const names = [...typing.entries()].filter(([, ts]) => ts && now - ts < 2500).map(([n]) => n);
    typingEl.textContent = names.length ? `${names.join(', ')} ${names.length === 1 ? 'печатает' : 'печатают'}…` : '';
  }
  setInterval(renderTyping, 800);

  function send() {
    const text = input.value.trim();
    if (!text || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'msg', text }));
    input.value = '';
    autoGrow();
    ws.send(JSON.stringify({ type: 'typing', on: false }));
    lastTypingSent = 0;
    input.focus();
    scrollDown();
  }

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(160, input.scrollHeight) + 'px';
  }

  form.addEventListener('submit', e => { e.preventDefault(); send(); });
  input.addEventListener('input', () => {
    autoGrow();
    if (!ws || ws.readyState !== 1) return;
    const now = Date.now();
    if (now - lastTypingSent > 1200) {
      ws.send(JSON.stringify({ type: 'typing', on: true }));
      lastTypingSent = now;
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => { if (ws?.readyState === 1) { ws.send(JSON.stringify({ type: 'typing', on: false })); lastTypingSent = 0; } }, 1500);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  /* ---------------- смена ника ---------------- */
  const renameBox = $('#renameBox'), renameForm = $('#renameForm'), renameInput = $('#renameInput');

  $('#rename').addEventListener('click', () => {
    closeMenu();
    renameInput.value = storedNick();
    renameBox.hidden = false;
    setTimeout(() => { renameInput.focus(); renameInput.select(); }, 60);
  });
  $('#renameCancel').addEventListener('click', () => { renameBox.hidden = true; });
  renameForm.addEventListener('submit', e => {
    e.preventDefault();
    const n = renameInput.value.trim().slice(0, 20);
    if (!n) return;
    localStorage.setItem('chat.nick', n);
    location.reload();
  });

  /* ---------------- блекджек ---------------- */
  addEventListener('chat-share', e => {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'msg', text: e.detail }));
    }
  });

  $('#gameBtn').addEventListener('click', () => {
    window.open('/blackjack.html', '_blank');
  });
})();
