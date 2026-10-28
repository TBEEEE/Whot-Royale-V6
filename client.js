// WHOT Royale client. The server is the source of truth; this file only renders state
// it is given and sends intents (create, join, play, draw, chat).
const socket = io();
const $ = (id) => document.getElementById(id);
const SHAPES = ['circle', 'triangle', 'cross', 'square', 'star'];
const SHAPE_PATHS = {
  circle: '<circle cx="12" cy="12" r="9.5"/>',
  triangle: '<path d="M12 2.5L22.5 21.5H1.5Z"/>',
  cross: '<path d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7z"/>',
  square: '<rect x="3" y="3" width="18" height="18" rx="1.5"/>',
  star: '<path d="M12 1.8l2.9 6.9 7.4.6-5.6 4.8 1.7 7.2L12 17.4l-6.4 3.9 1.7-7.2L1.7 9.3l7.4-.6z"/>',
};
const AVATAR_COLORS = ['#b3402f', '#1f6fa8', '#7a4aa8', '#b57a12', '#1b8a64', '#a8386b'];

let state = null;
let prev = null;
let pendingWild = null; // card id waiting for a shape choice
let clockSkew = 0; // server time minus local time
let soundOn = true;

/* ---------- small helpers ---------- */
const svg = (shape) => `<svg viewBox="0 0 24 24" aria-hidden="true">${SHAPE_PATHS[shape] || ''}</svg>`;
const seatColor = (i) => AVATAR_COLORS[i % AVATAR_COLORS.length];
const sessionKey = 'whot-session';
const nameKey = 'whot-name';

function store(op, key, value) {
  try {
    if (op === 'get') return localStorage.getItem(key);
    if (op === 'set') localStorage.setItem(key, value);
    if (op === 'del') localStorage.removeItem(key);
  } catch { /* storage may be blocked (private mode); the game still works without it */ }
  return null;
}

let errorTimer;
function notice(text, info = false) {
  const el = $('error');
  el.textContent = text;
  el.classList.toggle('info', info);
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => (el.textContent = ''), 5000);
}

function nickname() {
  const n = $('name').value.trim() || 'Player';
  store('set', nameKey, n);
  return n;
}

/* ---------- sound effects (synthesised, no files to download) ---------- */
let ctx;
function audio() {
  if (!soundOn) return null;
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  } catch { return null; }
}
function tone(freq, start, dur, { type = 'sine', gain = 0.06, slide = 0 } = {}) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + start;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}
const sfx = {
  deal: () => [0, 0.07, 0.14, 0.21].forEach((s, i) => tone(500 + i * 60, s, 0.08, { type: 'triangle' })),
  play: () => { tone(620, 0, 0.07, { type: 'triangle', gain: 0.08 }); tone(420, 0.04, 0.09, { type: 'triangle', gain: 0.06 }); },
  draw: () => tone(300, 0, 0.14, { type: 'sawtooth', gain: 0.03, slide: -120 }),
  penalty: () => { tone(220, 0, 0.18, { type: 'square', gain: 0.04 }); tone(165, 0.14, 0.26, { type: 'square', gain: 0.04 }); },
  market: () => [0, 0.08, 0.16, 0.24].forEach((s) => tone(380 + s * 900, s, 0.1, { type: 'triangle' })),
  skip: () => tone(700, 0, 0.22, { type: 'sine', slide: -450 }),
  turn: () => { tone(784, 0, 0.12, { gain: 0.07 }); tone(1047, 0.1, 0.2, { gain: 0.07 }); },
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.13, 0.28, { type: 'triangle', gain: 0.08 })),
  lose: () => [392, 330, 262].forEach((f, i) => tone(f, i * 0.16, 0.24, { type: 'sine', gain: 0.06 })),
  chat: () => tone(880, 0, 0.08, { gain: 0.035 }),
};
$('sound').onclick = () => {
  soundOn = !soundOn;
  $('sound').textContent = soundOn ? 'Sound on' : 'Sound off';
  $('sound').setAttribute('aria-pressed', String(soundOn));
  if (soundOn) sfx.chat();
};

/* ---------- actions ---------- */
$('create').onclick = () => socket.emit('create', { name: nickname() });
$('quick').onclick = () => socket.emit('quickJoin', { name: nickname() });
$('join').onclick = () => socket.emit('join', { code: $('code').value, name: nickname() });
$('code').onkeydown = (e) => { if (e.key === 'Enter') $('join').click(); };
$('name').onkeydown = (e) => { if (e.key === 'Enter') ($('code').value ? $('join') : $('create')).click(); };
$('start').onclick = () => socket.emit('start');
$('publicRoom').onchange = (e) => socket.emit('setPublic', e.target.checked);
$('leave').onclick = () => {
  const playing = state?.game?.phase === 'playing';
  if (playing && !confirm('Leave this round? Your cards go back in the pile.')) return;
  socket.emit('leave');
};
$('draw').onclick = () => socket.emit('draw');
$('cancelShape').onclick = () => { pendingWild = null; $('shapes').classList.add('hidden'); };
$('copy').onclick = async () => {
  const link = `${location.origin}/?room=${state.code}`;
  try {
    await navigator.clipboard.writeText(link);
    notice('Invite link copied. Send it to your friends.', true);
  } catch {
    notice(`Room code: ${state.code}`, true);
  }
};
const sendChat = () => {
  const box = $('message');
  if (!box.value.trim()) return;
  socket.emit('chat', box.value);
  box.value = '';
};
$('send').onclick = sendChat;
$('message').onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };
document.querySelectorAll('[data-reaction]').forEach((b) => (b.onclick = () => socket.emit('chat', b.dataset.reaction)));

/* ---------- connection and session recovery ---------- */
function setConn(text, cls) {
  const el = $('connection');
  el.textContent = text;
  el.className = `pill ${cls || ''}`;
}
function showWelcome() {
  state = prev = null;
  pendingWild = null;
  $('room').classList.add('hidden');
  $('welcome').classList.remove('hidden');
}
socket.on('connect', () => {
  setConn('Connected', 'ok');
  let saved = null;
  try { saved = JSON.parse(store('get', sessionKey) || 'null'); } catch { store('del', sessionKey); }
  if (saved && saved.code && saved.id && saved.token) socket.emit('reconnectPlayer', saved);
});
socket.on('disconnect', () => setConn('Offline. Reconnecting…', 'bad'));
socket.on('identity', (i) => store('set', sessionKey, JSON.stringify(i)));
socket.on('left', () => { store('del', sessionKey); showWelcome(); });
socket.on('replaced', (m) => { showWelcome(); notice(m); });
socket.on('errorMessage', (m) => {
  if (m === 'Saved session expired') { store('del', sessionKey); showWelcome(); return; }
  notice(m);
});

/* ---------- rendering ---------- */
function cardEl(c, tag = 'div') {
  const el = document.createElement(tag);
  if (c.shape === 'whot') {
    el.className = 'card whot';
    el.innerHTML = `<span class="word">WHOT<small>${c.number}</small></span>`;
    el.setAttribute('aria-label', 'WHOT 20, wild card');
  } else {
    el.className = `card ${SHAPES.includes(c.shape) ? c.shape : ''}`;
    el.innerHTML = `<span class="idx"><span>${Number(c.number)}</span>${svg(c.shape)}</span><span class="big">${svg(c.shape)}</span><span class="idx br"><span>${Number(c.number)}</span>${svg(c.shape)}</span>`;
    el.setAttribute('aria-label', `${c.number} of ${c.shape}s`);
  }
  return el;
}

const isLegal = (c, g) => c.number === 20 || c.number === g.top.number || c.shape === (g.chosenShape || g.top.shape);
const nameOf = (s, id) => s.players.find((p) => p.id === id)?.name || 'Player';

function renderSeats(s) {
  const list = $('seats');
  list.replaceChildren();
  const turnId = s.game?.phase === 'playing' ? s.game.turn : null;
  s.players.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = 'seat' + (p.connected ? '' : ' offline') + (p.id === turnId ? ' turn' : '') + (p.id === s.me ? ' me' : '');
    const av = document.createElement('div');
    av.className = 'avatar';
    av.style.background = seatColor(i);
    av.textContent = [...p.name][0]?.toUpperCase() || '?';
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = p.name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    if (s.started) {
      const n = document.createElement('span');
      n.className = 'cards-n';
      n.textContent = p.cards;
      meta.append(n, document.createTextNode(` cards · ${p.score} pts`));
    } else {
      meta.textContent = p.connected ? 'Ready' : 'Reconnecting…';
    }
    li.append(av, nm, meta);
    if (p.id === s.host) {
      const crown = document.createElement('span');
      crown.className = 'crown';
      crown.title = 'Host';
      crown.textContent = '👑';
      li.append(crown);
    }
    list.append(li);
  });
}

function renderLobby(s) {
  const lobby = $('lobby');
  const showLobby = !s.started;
  lobby.classList.toggle('hidden', !showLobby);
  if (!showLobby) return;
  const isHost = s.me === s.host;
  const n = s.players.length;
  let text = n < 2 ? 'Waiting for players. Share the room code or invite link.' : `${n} of 6 players are here.`;
  if (s.startsAt) text += ' The match starts automatically.';
  $('lobbyStatus').textContent = text;
  $('publicRoom').checked = !!s.public;
  $('publicRoom').disabled = !isHost;
  $('publicLabel').classList.toggle('hidden', s.auto);
  $('start').classList.toggle('hidden', !isHost);
  $('start').disabled = n < 2;
  $('lobbyHint').textContent = isHost
    ? n < 2 ? 'You need at least 2 players to start.' : 'Start whenever everyone is ready.'
    : 'The host starts the game.';
}

function renderTable(s) {
  const g = s.game;
  const gameEl = $('game');
  gameEl.classList.toggle('hidden', !g);
  if (!g) return;
  const mine = g.turn === s.me && g.phase === 'playing';
  const finished = g.phase === 'finished';

  const turn = $('turn');
  turn.classList.toggle('mine', mine);
  turn.textContent = finished ? 'Round complete' : mine ? 'Your turn' : `${nameOf(s, g.turn)} is playing`;

  // top card (animate only when it changes)
  const slot = $('top');
  if (!prev?.game || prev.game.top.id !== g.top.id || slot.childElementCount === 0) {
    slot.replaceChildren();
    const c = cardEl(g.top);
    if (prev?.game) c.classList.add('enter');
    slot.append(c);
  }
  const info = $('shapeInfo');
  info.replaceChildren();
  if (g.chosenShape && SHAPES.includes(g.chosenShape)) {
    const badge = document.createElement('span');
    badge.className = 'shape-badge s-' + g.chosenShape;
    badge.innerHTML = svg(g.chosenShape);
    const t = document.createElement('span');
    t.style.color = 'var(--cream)';
    t.textContent = `Next shape: ${g.chosenShape}`;
    badge.append(t);
    info.append(badge);
  }

  const draw = $('draw');
  draw.disabled = !mine;
  draw.classList.toggle('pulse', mine);
  draw.classList.toggle('penalty', !!g.pending);
  draw.innerHTML = g.pending ? `<span>+${g.pending}</span>` : '<span>W</span>';
  draw.setAttribute('aria-label', g.pending ? `Draw ${g.pending} cards` : 'Draw a card');
  $('drawcount').textContent = `${g.drawCount} left`;

  $('instructions').textContent = finished
    ? ''
    : mine
      ? g.pending
        ? `Penalty: tap the pile to draw ${g.pending} cards.`
        : g.hand.some((c) => isLegal(c, g)) ? 'Tap a glowing card to play it, or draw from the pile.' : 'No card fits. Tap the pile to draw.'
      : 'Waiting for the other player…';

  // hand
  const hand = $('hand');
  // Rebuild only when the hand or what is playable changes, so taps are never lost to a re-render.
  const sig = [mine, g.pending, g.top.id, g.chosenShape, ...g.hand.map((c) => c.id)].join(',');
  if (hand.dataset.sig !== sig) {
  hand.dataset.sig = sig;
  const n = g.hand.length;
  hand.style.setProperty('--ov', n <= 5 ? '8px' : n <= 7 ? '-8px' : n <= 10 ? '-20px' : '-30px');
  hand.replaceChildren();
  g.hand.forEach((c) => {
    const b = cardEl(c, 'button');
    const legal = mine && !g.pending && isLegal(c, g);
    b.disabled = !legal;
    b.classList.toggle('playable', legal);
    b.classList.toggle('dim', mine && !legal);
    b.onclick = () => {
      if (c.number === 20) {
        pendingWild = c.id;
        $('shapes').classList.remove('hidden');
        $('shapes').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else {
        socket.emit('play', { cardId: c.id });
      }
    };
    hand.append(b);
  });
  }
  $('hand').parentElement.classList.toggle('hidden', finished && g.hand.length === 0);
  $('handcount').textContent = `${g.hand.length} card${g.hand.length === 1 ? '' : 's'}`;
  if (!mine || g.pending) { pendingWild = null; $('shapes').classList.add('hidden'); }

  // result
  const result = $('result');
  result.classList.toggle('hidden', !finished);
  result.replaceChildren();
  if (finished) {
    const won = g.winner === s.me;
    result.append(document.createTextNode(won ? 'You win this round! 🏆' : `${nameOf(s, g.winner)} wins the round`));
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = `Round ${g.round} is over. Scores carry into the next round.`;
    result.append(sub);
    const row = document.createElement('div');
    row.className = 'row';
    const again = document.createElement('button');
    again.className = 'primary';
    again.textContent = 'Play next round';
    again.disabled = s.players.length < 2;
    again.onclick = () => socket.emit('nextRound');
    row.append(again);
    result.append(row);
  }

  // log + scoreboard
  const log = $('log');
  log.replaceChildren();
  g.log.forEach((t) => { const d = document.createElement('div'); d.textContent = t; log.append(d); });
  const board = $('board');
  board.replaceChildren();
  [...s.players].sort((a, b) => b.score - a.score).forEach((p, i) => {
    const d = document.createElement('div');
    const l = document.createElement('span');
    l.textContent = `${i + 1}. ${p.name}`;
    const r = document.createElement('strong');
    r.textContent = `${p.score} pts`;
    d.append(l, r);
    board.append(d);
  });
}

function renderChat(s) {
  const box = $('messages');
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  box.replaceChildren();
  s.chat.forEach((m) => {
    const p = document.createElement('p');
    const b = document.createElement('b');
    b.textContent = `${m.name}: `;
    p.append(b, document.createTextNode(m.text));
    box.append(p);
  });
  if (stick) box.scrollTop = box.scrollHeight;
}

function playSounds(s, before) {
  const g = s.game, pg = before?.game;
  if (!g) return;
  if (!pg) { sfx.deal(); return; }
  if (pg.round !== g.round) { sfx.deal(); return; }
  if (g.phase === 'finished' && pg.phase !== 'finished') { (g.winner === s.me ? sfx.win : sfx.lose)(); return; }
  if (g.top.id !== pg.top.id) {
    const n = g.top.number;
    if (n === 14) sfx.market(); else if (n === 8) sfx.skip(); else if (n === 2 || n === 5) sfx.penalty(); else sfx.play();
  } else if (g.log.at(-1) !== pg.log.at(-1) && /drew|ran out|away/.test(g.log.at(-1) || '')) sfx.draw();
  if (g.turn === s.me && pg.turn !== s.me && g.phase === 'playing') setTimeout(sfx.turn, 220);
  if (s.chat.length > (before?.chat.length ?? 0) && s.chat.at(-1)?.name !== nameOf(s, s.me)) sfx.chat();
}

function render(s) {
  clockSkew = s.now - Date.now();
  $('welcome').classList.add('hidden');
  $('room').classList.remove('hidden');
  $('roomcode').textContent = s.code;
  renderSeats(s);
  renderLobby(s);
  renderTable(s);
  renderChat(s);
  playSounds(s, prev);
  prev = state = s;
  tickClock();
}
socket.on('state', render);

/* ---------- turn clock and match countdown ---------- */
const TURN_MS_GUESS = 45000;
function tickClock() {
  if (!state) return;
  const bar = $('clockbar');
  const g = state.game;
  const now = Date.now() + clockSkew;
  if (g && g.phase === 'playing' && state.deadline) {
    const left = Math.max(0, state.deadline - now);
    const total = Math.max(left, state.deadline - (state.turnStart || state.deadline - TURN_MS_GUESS));
    bar.style.width = `${Math.min(100, (left / total) * 100)}%`;
    bar.classList.toggle('low', left < 10000);
  } else {
    bar.style.width = '0';
  }
  if (!state.started && state.startsAt) {
    const secs = Math.max(0, Math.ceil((state.startsAt - now) / 1000));
    $('lobbyHint').textContent = `Match starts in ${secs}s. The host can start now.`;
  }
}
setInterval(tickClock, 250);

/* ---------- wild card shape picker ---------- */
SHAPES.forEach((shape) => {
  const b = document.createElement('button');
  b.className = 's-' + shape;
  b.innerHTML = `${svg(shape)}<span>${shape}</span>`;
  b.onclick = () => {
    if (pendingWild == null) return;
    socket.emit('play', { cardId: pendingWild, shape });
    pendingWild = null;
    $('shapes').classList.add('hidden');
  };
  $('shapeButtons').append(b);
});

/* ---------- boot ---------- */
const savedName = store('get', nameKey);
if (savedName && savedName !== 'Player') $('name').value = savedName;
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('code').value = urlRoom.toUpperCase().slice(0, 6);
