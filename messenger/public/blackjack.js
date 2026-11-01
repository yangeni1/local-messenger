/* 🃏 Блэкджек внутри мессенджера: играешь против дилера, баланс живёт в браузере. */
(() => {
  const START = 1000;
  const MIN_BET = 10;
  const SUITS = [{ s: '♠', red: false }, { s: '♥', red: true }, { s: '♦', red: true }, { s: '♣', red: false }];
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

  /* ---------- колода ---------- */
  let deck = [];
  function newDeck() {
    deck = [];
    for (const su of SUITS) for (const r of RANKS) deck.push({ r, s: su.s, red: su.red });
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
  }
  const draw = () => { if (deck.length < 15) newDeck(); return deck.pop(); };
  const val = c => c.r === 'A' ? 11 : 'JQK'.includes(c.r) ? 10 : +c.r;
  function total(hand) {
    let t = hand.reduce((a, c) => a + val(c), 0);
    let aces = hand.filter(c => c.r === 'A').length;
    while (t > 21 && aces > 0) { t -= 10; aces--; }
    return t;
  }

  /* ---------- состояние ---------- */
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const st = {
    balance: Math.max(0, num(localStorage.getItem('bj.balance'), START)),
    bet: Math.max(MIN_BET, num(localStorage.getItem('bj.bet'), 100)),
    player: [], dealer: [],
    phase: 'idle',      // idle | player | done
    hole: false,        // закрыта ли карта дилера
    lock: false,        // пауза после раунда (кнопки заблокированы)
    net: 0,
  };

  const el = id => document.getElementById(id);
  const ui = {
    root: el('game'), dealer: el('bjDealer'), player: el('bjPlayer'),
    dTotal: el('bjDTotal'), pTotal: el('bjPTotal'), banner: el('bjBanner'), msg: el('bjMsg'),
    bal: el('bjBal'), bet: el('bjBet'),
    deal: el('bjDeal'), hit: el('bjHit'), stand: el('bjStand'), dbl: el('bjDouble'),
    betClear: el('bjBetClear'), share: el('bjShare'), close: el('bjClose'), open: el('gameBtn'),
  };

  /* ---------- отрисовка ---------- */
  function cardEl(c, back, delay) {
    const d = document.createElement('div');
    d.className = 'card' + (back ? ' back' : (c.red ? ' red' : ''));
    if (delay != null) { d.style.animationDelay = delay + 'ms'; d.classList.add('deal'); }
    if (!back) {
      d.innerHTML = `<div class="top">${c.r}<span>${c.s}</span></div><div class="mid">${c.s}</div><div class="bot">${c.r}<span>${c.s}</span></div>`;
    }
    return d;
  }

  let pShown = 0, dShown = 0;
  function clearTable() { ui.player.innerHTML = ''; ui.dealer.innerHTML = ''; pShown = dShown = 0; }

  // новые карты дорисовываются по одной (с анимацией), остальные не пересоздаются
  function render(animate) {
    const p = total(st.player), dHand = st.dealer;
    while (pShown < st.player.length) {
      const i = pShown++;
      ui.player.appendChild(cardEl(st.player[i], false, animate ? i * 70 : null));
    }
    while (dShown < dHand.length) {
      const i = dShown++;
      ui.dealer.appendChild(cardEl(dHand[i], st.hole && i === 1, animate ? i * 70 : null));
    }
    ui.pTotal.textContent = st.player.length ? `${p}${p > 21 ? ' · перебор' : ''}` : '';
    ui.dTotal.textContent = dHand.length ? (st.hole ? `${total([dHand[0]])} + ?` : String(total(dHand))) : '';
    ui.pTotal.classList.toggle('bust', p > 21);
  }

  // после открытия закрытой карты перерисовываем руку дилера целиком
  function revealDealer() {
    st.hole = false;
    ui.dealer.innerHTML = '';
    dShown = 0;
    for (const c of st.dealer) ui.dealer.appendChild(cardEl(c, false, null));
    ui.dTotal.textContent = String(total(st.dealer));
  }

  let bannerTimer = null;
  function banner(text, sub) {
    ui.banner.innerHTML = `<b>${text}</b>${sub ? `<span>${sub}</span>` : ''}`;
    ui.banner.classList.add('show');
    clearTimeout(bannerTimer);
  }
  function hideBanner() { ui.banner.classList.remove('show'); }

  function say(text) { ui.msg.textContent = text || ''; }

  function persist() {
    localStorage.setItem('bj.balance', st.balance);
    localStorage.setItem('bj.bet', st.bet);
  }

  function sync() {
    ui.bal.textContent = `${st.balance} 🪙`;
    ui.bet.textContent = `${st.bet} 🪙`;
    const idle = st.phase === 'idle';
    ui.deal.disabled = !idle || st.lock || st.balance < MIN_BET;
    ui.hit.disabled = st.phase !== 'player';
    ui.stand.disabled = st.phase !== 'player';
    ui.dbl.disabled = st.phase !== 'player' || st.player.length !== 2 || st.balance < st.bet;
    ui.betClear.disabled = !idle;
    persist();
  }

  /* ---------- логика ---------- */
  function deal() {
    if (st.phase !== 'idle' || st.lock) return;
    if (st.balance < MIN_BET) { say('Не хватает фишек — нажми «Новая игра»'); return; }
    if (st.bet > st.balance) st.bet = st.balance;
    if (st.bet < MIN_BET) { say(`Минимальная ставка — ${MIN_BET} 🪙`); return; }

    say('');
    hideBanner();
    ui.share.hidden = true;
    st.net = 0;
    st.balance -= st.bet;
    st.player = [draw(), draw()];
    st.dealer = [draw(), draw()];
    st.phase = 'player';
    st.hole = true;
    clearTable();
    render(true);
    sync();

    if (total(st.player) === 21) { st.phase = 'done'; setTimeout(() => finish('БЛЭКДЖЕК!', 'bj'), 420); }
  }

  function hit() {
    if (st.phase !== 'player') return;
    st.player.push(draw());
    render(true);
    sync();
    if (total(st.player) > 21) { st.phase = 'done'; finish('ПЕРЕБОР', 'lose'); }
  }

  function double() {
    if (st.phase !== 'player' || st.player.length !== 2 || st.balance < st.bet) return;
    st.balance -= st.bet;
    st.bet *= 2;
    st.player.push(draw());
    render(true);
    sync();
    if (total(st.player) > 21) { st.phase = 'done'; return finish('ПЕРЕБОР', 'lose'); }
    stand();
  }

  function stand() {
    if (st.phase !== 'player') return;
    st.phase = 'done';
    revealDealer();
    sync();
    dealerPlay();
  }

  function dealerPlay() {
    const step = () => {
      const dt = total(st.dealer), pt = total(st.player);
      if (dt < 17 && pt <= 21) {
        st.dealer.push(draw());
        revealDealer();
        return setTimeout(step, 520);
      }
      const d = total(st.dealer);
      if (pt > 21) return finish('ПЕРЕБОР', 'lose');
      if (d > 21) return finish('ДИЛЕР ПЕРЕБРАЛ', 'win');
      if (pt > d) return finish('ПОБЕДА', 'win');
      if (pt === d) return finish('НИЧЬЯ', 'push');
      finish('ДИЛЕР ВЫИГРАЛ', 'lose');
    };
    setTimeout(step, 380);
  }

  function finish(title, kind) {
    st.phase = 'idle';
    revealDealer();
    sync();

    const payout = kind === 'bj' ? Math.round(st.bet * 2.5) : kind === 'win' ? st.bet * 2 : kind === 'push' ? st.bet : 0;
    st.balance += payout;
    st.net = payout - st.bet;

    const sub = st.net > 0 ? `+${st.net} 🪙` : st.net === 0 ? 'ставка вернулась' : `−${st.bet} 🪙`;
    banner(title, sub);

    if (st.balance < MIN_BET) {
      st.balance = START;
      say('Фишки кончились — казино выдало ещё 1000 🪙');
    }
    st.bet = Math.min(Math.max(MIN_BET, st.bet), Math.max(MIN_BET, st.balance));

    st.lock = true;
    setTimeout(() => { st.lock = false; sync(); }, 800);
    sync();
    ui.share.hidden = st.net <= 0;
    if (st.net > 0) ui.share.dataset.text = `🃏 Блэкджек: ${title} — ${st.net > 0 ? '+' : ''}${st.net} 🪙`;
  }

  function newGame() {
    st.balance = START;
    st.bet = 100;
    st.phase = 'idle';
    st.hole = false;
    st.player = [];
    st.dealer = [];
    st.lock = false;
    hideBanner();
    clearTable();
    render(false);
    say('');
    ui.share.hidden = true;
    sync();
  }

  /* ---------- открыть / закрыть ---------- */
  function open() {
    document.body.classList.remove('menu-open');
    ui.root.hidden = false;
    if (!st.player.length) { clearTable(); render(false); }
    sync();
  }
  function close() { ui.root.hidden = true; }

  ui.open.addEventListener('click', open);
  ui.close.addEventListener('click', close);

  /* ---------- кнопки ---------- */
  ui.deal.addEventListener('click', deal);
  ui.hit.addEventListener('click', hit);
  ui.stand.addEventListener('click', stand);
  ui.dbl.addEventListener('click', double);
  ui.betClear.addEventListener('click', () => { st.bet = MIN_BET; say(''); sync(); });
  el('bjNewGame').addEventListener('click', newGame);
  ui.share.addEventListener('click', () => {
    const text = ui.share.dataset.text || '🃏 Блэкджек';
    dispatchEvent(new CustomEvent('chat-share', { detail: text }));
    ui.share.hidden = true;
    say('Отправил в чат 👍');
  });
  document.querySelectorAll('#game .chipbtn').forEach(b => {
    b.addEventListener('click', () => {
      const add = +b.dataset.chip;
      st.bet = Math.min(Math.max(MIN_BET, st.bet + add), Math.max(MIN_BET, st.balance));
      sync();
    });
  });

  /* ---------- клавиатура ---------- */
  addEventListener('keydown', e => {
    if (ui.root.hidden) return;
    if (e.key === 'Escape') { close(); return; }
    const k = e.key.toLowerCase();
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (st.phase === 'idle') deal(); return; }
    if (k === 'h' || k === 'р') hit();
    if (k === 's' || k === 'ы') stand();
    if (k === 'd' || k === 'в') double();
  });

  clearTable();
  render(false);
  sync();
  say('Пробел — раздать · H — ещё · S — хватит · D — удвоить');
})();
