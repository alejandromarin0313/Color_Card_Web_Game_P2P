// UNO P2P — single-file JS (auth + lobby/chat + game + net)
// NOTE: No backend. Simple localStorage auth. PeerJS for P2P (host = room owner).
// This is a teaching/portfolio build, not production-grade. :)

// ---------- State ----------
const state = {
  me: null,            // { username }
  peer: null,          // PeerJS peer
  isHost: false,
  roomCode: null,      // equals host's peer id
  conns: new Map(),    // peerId -> DataConnection (host's map). For guest: one connection to host.
  players: [],         // array of {id, name}
  // Game state (host authoritative)
  game: null           // see createInitialGameState()
};

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);
const on = (el, ev, fn) => el.addEventListener(ev, fn);
const uid = () => Math.random().toString(36).slice(2, 10);
function toast(msg) { console.log(msg); } // keep simple

function setView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// Warn if not HTTPS or localhost
try{
  const warn = document.getElementById('https-warning');
  const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const isHttps = location.protocol === 'https:';
  if (warn && !(isHttps || isLocalhost)) warn.style.display = 'block';
}catch{}

// ---------- AUTH ----------
const authForm = $('#auth-form');
const authUsername = $('#auth-username');
const authPassword = $('#auth-password');
const meNameSpan = $('#me-name');
const logoutBtn = $('#logout-btn');

on(authForm, 'submit', (e) => {
  e.preventDefault();
  const u = authUsername.value.trim();
  const p = authPassword.value;
  if (!u || !p) return;

  const users = JSON.parse(localStorage.getItem('users') || '{}');
  if (users[u]) {
    if (users[u] !== p) {
      alert('Wrong password.');
      return;
    }
  } else {
    // register
    users[u] = p;
    localStorage.setItem('users', JSON.stringify(users));
  }
  state.me = { username: u };
  localStorage.setItem('currentUser', u);
  meNameSpan.textContent = u;
  setView('view-menu');
});

on(logoutBtn, 'click', () => {
  localStorage.removeItem('currentUser');
  location.reload();
});

// Auto login if saved
const saved = localStorage.getItem('currentUser');
if (saved) {
  state.me = { username: saved };
  meNameSpan.textContent = saved;
  setView('view-menu');
}

// ---------- MENU (Create / Join) ----------
const createBtn = $('#create-room-btn');
const joinForm = $('#join-form');
const joinCodeInput = $('#join-code');

on(createBtn, 'click', async () => {
  state.isHost = true;                 // 1) primero
  await ensurePeer();                  // 2) crea el Peer
  state.roomCode = state.peer.id;
  $('#room-code').textContent = state.roomCode;
  $('#host-controls').classList.remove('hide');

  await hostSetup();

  // 3) Asegura que el host figure en el lobby (evita condiciones de carrera)
  state.players = [{ id: state.peer.id, name: state.me.username }];
  refreshPlayersList();

  setView('view-lobby');
  addSystemChat('Lobby created. Share the room code to invite others.');
});

on(joinForm, 'submit', async (e) => {
  e.preventDefault();
  const code = joinCodeInput.value.trim();
  if (!code) return;
  await ensurePeer();
  state.isHost = false;
  state.roomCode = code;
  $('#room-code').textContent = code;
  await guestSetup(code);
  setView('view-lobby');
});

// ---------- PeerJS (Networking) ----------
async function ensurePeer() {
  if (state.peer) return;
  state.peer = new Peer();
  state.peer.on('open', (id) => {
    console.log('My peer id:', id);
    if (state.isHost) {
      state.roomCode = id;
      $('#room-code').textContent = id;
    }
  });
  state.peer.on('error', (err) => {
    console.error(err);
    alert('Peer error: ' + err.type);
  });
}

// Host: accept connections
async function hostSetup() {
  state.players = [{ id: state.peer.id, name: state.me.username }];
  state.conns.clear();

  state.peer.on('connection', (conn) => {
    conn.on('open', () => {
      state.conns.set(conn.peer, conn);
      conn.on('data', (msg) => handleMessage(conn, msg));
      sendConn(conn, { type: 'hello' });
    });
    conn.on('close', () => {
      state.conns.delete(conn.peer);
      removePlayer(conn.peer);
      broadcast({ type: 'players', players: state.players });
      addSystemChat(`${conn.peer} left.`);
      refreshPlayersList();
    });
  });
}

// Guest: connect to host
async function guestSetup(hostId) {
  function connectNow() {
    const conn = state.peer.connect(hostId);
    conn.on('open', () => {
      state.hostConn = conn;
      conn.on('data', (msg) => handleMessage(conn, msg));
      sendConn(conn, { type: 'join', name: state.me.username });
    });
    conn.on('error', (e) => {
      console.error('Guest connection error:', e);
      alert('Connection error (guest): ' + e.type);
    });
  }

  // Si el peer ya está abierto, conecta; si no, espera al evento 'open'
  if (state.peer?.open) {
    connectNow();
  } else {
    state.peer.once('open', connectNow);
  }
}


// Message helpers
function sendConn(conn, data) { try { conn.send(data); } catch {} }
function broadcast(data) {
  for (const conn of state.conns.values()) sendConn(conn, data);
}

// ---------- Lobby UI + Chat ----------
const chatLog = $('#chat-log');
const chatForm = $('#chat-form');
const chatInput = $('#chat-input');
const playersList = $('#players-list');
const startBtn = $('#start-game-btn');
const leaveRoomBtn = $('#leave-room-btn');
const copyCodeBtn = $('#copy-code-btn');

on(copyCodeBtn, 'click', async () => {
  await navigator.clipboard.writeText(state.roomCode || '');
  copyCodeBtn.textContent = 'Copied!';
  setTimeout(() => (copyCodeBtn.textContent = 'Copy code'), 1200);
});

on(leaveRoomBtn, 'click', () => {
  if (state.isHost) {
    alert('As host, leaving will end the room.');
  }
  location.reload();
});

on(chatForm, 'submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  const msg = { type: 'chat', from: state.me.username, text, scope: 'lobby' };
  if (state.isHost) {
    addChat(chatLog, msg);
    broadcast(msg);
  } else {
    sendConn(state.hostConn, msg);
  }
  chatInput.value = '';
});

on(startBtn, 'click', () => {
  if (!state.isHost) return;
  if (state.players.length < 2) return alert('Need at least 2 players.');
  if (state.players.length > 4) return alert('Max 4 players.');

 
  state.game = createInitialGameState(state.players);
  enterGameView();
  broadcast({ type: 'start', room: state.roomCode });
  pushFullState();
  for (const p of state.players) {
    if (p.id === state.peer.id) continue;
    const conn = state.conns.get(p.id);
    if (conn) {
      const myHand = state.game.hands[p.id] || [];
      sendConn(conn, { type: 'myhand', hand: myHand });
    }
  }
});

function refreshPlayersList() {
  playersList.innerHTML = '';
  state.players.forEach(p => {
    const li = document.createElement('li');
    li.textContent = p.name + (p.id === state.peer?.id ? ' (host)' : '');
    playersList.appendChild(li);
  });
}

function addChat(container, { from, text }) {
  const line = document.createElement('div');
  line.innerHTML = `<b>${from}:</b> ${escapeHtml(text)}`;
  container.appendChild(line);
  container.scrollTop = container.scrollHeight;
}
function addSystemChat(text) {
  const line = document.createElement('div');
  line.className = 'muted small';
  line.textContent = text;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// ---------- Message routing ----------
function handleMessage(conn, msg) {
  switch (msg.type) {
    case 'hello':
      sendConn(conn, { type: 'who' });
      break;
    case 'who':
      break;
    case 'join':
      if (!state.isHost) return;
      state.players.push({ id: conn.peer, name: msg.name });
      addSystemChat(`${msg.name} joined.`);
      broadcast({ type: 'players', players: state.players });
      refreshPlayersList();
      break;
    case 'players':
      state.players = msg.players;
      refreshPlayersList();
      break;
    case 'chat':
      if (state.isHost) {
        broadcast(msg);
        if (msg.scope === 'lobby') addChat(chatLog, msg);
        else addChat($('#chat-log-game'), msg);
      } else {
        if (msg.scope === 'lobby') addChat(chatLog, msg);
        else addChat($('#chat-log-game'), msg);
      }
      break;
    case 'start':
      enterGameView();
      break;
    case 'state':
      state.game = msg.state;
      renderGame();
      break;
    case 'myhand':
      state.myHand = msg.hand;
      renderHand();
      break;
    case 'action':
      if (state.isHost) onGuestAction(conn, msg);
      break;
    case 'effect':
      $('#effects').textContent = msg.text || '';
      break;
  }
}

// ---------- GAME LOGIC ----------
const COLORS = ['red','yellow','green','blue'];
const NUMBERS = ['0','1','2','3','4','5','6','7','8','9'];
const ACTIONS = ['skip','reverse','draw2'];
const WILDS = ['wild','wild4'];

function createDeck() {
  const deck = [];
  for (const c of COLORS) {
    deck.push({ color: c, value: '0', type: 'number' });
    for (const n of NUMBERS.slice(1)) {
      deck.push({ color: c, value: n, type: 'number' });
      deck.push({ color: c, value: n, type: 'number' });
    }
    for (const a of ACTIONS) {
      deck.push({ color: c, value: a, type: a });
      deck.push({ color: c, value: a, type: a });
    }
  }
  for (let i=0;i<4;i++) deck.push({ color: 'wild', value: 'wild', type: 'wild' });
  for (let i=0;i<4;i++) deck.push({ color: 'wild', value: 'wild4', type: 'wild4' });
  return shuffle(deck);
}

function shuffle(a) {
  for (let i=a.length-1;i>0;i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

function createInitialGameState(players) {
  const deck = createDeck();
  const hands = {};
  for (const p of players) hands[p.id] = [];
  for (let d=0; d<7; d++) {
    for (const p of players) hands[p.id].push(deck.pop());
  }
  let discard = deck.pop();
  while (discard.color === 'wild') {
    deck.unshift(discard);
    discard = deck.pop();
  }
  return {
    players,
    hands,
    deck,
    discardPile: [discard],
    currentColor: discard.color,
    turnIndex: 0,
    direction: 1,
    pendingDraw: 0,
    started: true
  };
}

function topDiscard() {
  return state.game.discardPile[state.game.discardPile.length-1];
}

function canPlay(card, game) {
  const top = game.discardPile[game.discardPile.length-1];
  if (card.color === 'wild') return true;
  if (card.color === game.currentColor) return true;
  if (top.type === 'number' && card.type === 'number' && top.value === card.value) return true;
  if (top.type !== 'number' && card.type === top.type) return true;
  return false;
}

function advanceTurn(game, steps=1) {
  const n = game.players.length;
  game.turnIndex = (game.turnIndex + game.direction*steps + n) % n;
}

function pushFullState() {
  if (!state.isHost) return;
  const sanitized = JSON.parse(JSON.stringify(state.game));
  sanitized.hands = {};
  for (const p of state.game.players) {
    sanitized.hands[p.id] = { count: state.game.hands[p.id].length };
  }
  const msg = { type: 'state', state: sanitized };
  broadcast(msg);
  renderGame();
  renderHand();
}

// ---------- GAME UI ----------
const roomCodeGameSpan = $('#room-code-game');
const meNameGameSpan = $('#me-name-game');
const turnIndicator = $('#turn-indicator');
const opponentsDiv = $('#opponents');
const handDiv = $('#hand');
const drawBtn = $('#draw-btn');
const passBtn = $('#pass-btn');
const colorDialog = $('#color-dialog');

on($('#chat-form-game'), 'submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input-game');
  const text = input.value.trim();
  if (!text) return;
  const msg = { type: 'chat', from: state.me.username, text, scope: 'game' };
  if (state.isHost) {
    addChat($('#chat-log-game'), msg);
    broadcast(msg);
  } else {
    sendConn(state.hostConn, msg);
  }
  input.value='';
});

on($('#exit-to-menu'), 'click', () => {
  if (!confirm('Exit the game to menu?')) return;
  location.reload();
});

on(drawBtn, 'click', () => {
  if (!isMyTurn()) return alert('Not your turn.');
  if (state.isHost) {
    hostDrawCard(state.peer.id);
  } else {
    sendConn(state.hostConn, { type: 'action', action: 'draw' });
  }
});
on(passBtn, 'click', () => {
  if (!isMyTurn()) return alert('Not your turn.');
  if (state.isHost) {
    hostPass(state.peer.id);
  } else {
    sendConn(state.hostConn, { type: 'action', action: 'pass' });
  }
});

function onGuestAction(conn, payload) {
  const { action, cardIndex, color } = payload;
  const pid = conn.peer;
  switch (action) {
    case 'draw': hostDrawCard(pid); break;
    case 'pass': hostPass(pid); break;
    case 'play': hostPlayCard(pid, cardIndex, color); break;
  }
}

function isMyTurn() {
  if (!state.game) return false;
  const current = state.game.players[state.game.turnIndex];
  return current.id === state.peer.id;
}

function enterGameView() {
  roomCodeGameSpan.textContent = state.roomCode;
  meNameGameSpan.textContent = state.me.username;
  $('#turn-indicator').textContent = '';
  setView('view-game');
  renderGame();
  renderHand();
}

function renderGame() {
  if (!state.game) return;
  const current = state.game.players[state.game.turnIndex];
  turnIndicator.textContent = current.name;

  opponentsDiv.innerHTML = '';
  for (const p of state.game.players) {
    if (p.id === state.peer.id) continue;
    const box = document.createElement('div');
    box.className = 'opponent';
    const count = state.isHost ? state.game.hands[p.id].length : (state.game.hands[p.id]?.count ?? 0);
    box.innerHTML = box.innerHTML = `
  <div class="name">${p.name}</div>
  <div class="status">${current.id===p.id?'Their turn':''}</div>
  <div class="stack">${Array.from({length: count}).map(()=>'<div class="card-svg small back"></div>').join('')}</div>
`;

    opponentsDiv.appendChild(box);
  }

  const top = topDiscard();
  const discard = $('#discard-pile');
  discard.className = 'card-svg ' + cardCss(top);
  discard.textContent = labelFor(top);
}

function renderHand() {
  handDiv.innerHTML = '';
  const myCards = state.isHost
    ? (state.game && state.game.hands && state.game.hands[state.peer?.id]) || []
    : (state.myHand || []);

  if (!Array.isArray(myCards)) {
    console.warn('[renderHand] No hand yet for', state.isHost ? state.peer?.id : 'guest');
    return;
  }

  myCards.forEach((card, idx) => {
    const el = document.createElement('div');
    el.className = 'card-svg ' + cardCss(card);
    el.textContent = labelFor(card);
    el.title = 'Click to play';
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => tryPlayCard(idx, card));
    handDiv.appendChild(el);
  });
}



function cardCss(card) {
  if (card.color === 'wild') return 'card-wild';
  return 'card-' + card.color;
}
function labelFor(card) {
  if (card.type === 'number') return card.value;
  if (card.type === 'draw2') return '+2';
  if (card.type === 'reverse') return '↺';
  if (card.type === 'skip') return '⦸';
  if (card.type === 'wild') return 'WILD';
  if (card.type === 'wild4') return '+4';
  return '?';
}

function tryPlayCard(index, card) {
  if (!isMyTurn()) return alert('Not your turn.');
  if (card.color === 'wild') {
    colorDialog.showModal();
    colorDialog.querySelectorAll('.color-chip').forEach(btn => {
      btn.onclick = () => {
        const chosen = btn.dataset.color;
        colorDialog.close();
        if (state.isHost) {
          hostPlayCard(state.peer.id, index, chosen);
        } else {
          sendConn(state.hostConn, { type: 'action', action: 'play', cardIndex: index, color: chosen });
        }
      };
    });
  } else {
    if (state.isHost) {
      hostPlayCard(state.peer.id, index, null);
    } else {
      sendConn(state.hostConn, { type: 'action', action: 'play', cardIndex: index });
    }
  }
}

function hostDrawCard(pid) {
  const g = state.game;
  if (g.deck.length === 0) reshuffleFromDiscard();
  const card = g.deck.pop();
  if (!card) return;
  g.hands[pid].push(card);
  pushFullState();
  if (pid !== state.peer.id) {
    const conn = state.conns.get(pid);
    if (conn) sendConn(conn, { type: 'myhand', hand: g.hands[pid] });
  }
}

function hostPass(pid) {
  const g = state.game;
  const current = g.players[g.turnIndex].id;
  if (current !== pid) return;
  advanceTurn(g, 1);
  pushFullState();
}

function hostPlayCard(pid, index, chosenColor) {
  const g = state.game;
  const currentP = g.players[g.turnIndex].id;
  if (pid !== currentP) return;
  const hand = g.hands[pid];
  const card = hand[index];
  if (!card) return;
  if (!canPlay(card, g)) return;

  hand.splice(index, 1);
  g.discardPile.push(card);
  if (card.color === 'wild') {
    g.currentColor = chosenColor || COLORS[Math.floor(Math.random()*4)];
  } else {
    g.currentColor = card.color;
  }

  let effectText = '';
  if (card.type === 'reverse') {
    g.direction *= -1;
    effectText = 'Reverse!';
  } else if (card.type === 'skip') {
    advanceTurn(g, 1);
    effectText = 'Skip!';
  } else if (card.type === 'draw2') {
    const next = g.players[(g.turnIndex + g.direction + g.players.length) % g.players.length].id;
    drawN(next, 2);
    effectText = '+2 to next player!';
  } else if (card.type === 'wild4') {
    const next = g.players[(g.turnIndex + g.direction + g.players.length) % g.players.length].id;
    drawN(next, 4);
    effectText = '+4 to next player!';
  }

  if (hand.length === 0) {
    broadcast({ type: 'effect', text: `${getName(pid)} wins!` });
    alert(`${getName(pid)} wins!`);
    pushFullState();
    return;
  }

  advanceTurn(g, 1);
  pushFullState();
  if (effectText) broadcast({ type: 'effect', text: effectText });

  for (const p of g.players) {
    if (p.id === state.peer.id) continue;
    const conn = state.conns.get(p.id);
    if (conn) sendConn(conn, { type: 'myhand', hand: g.hands[p.id] });
  }
}

function drawN(pid, n) {
  for (let i=0;i<n;i++) {
    if (state.game.deck.length === 0) reshuffleFromDiscard();
    const c = state.game.deck.pop();
    if (c) state.game.hands[pid].push(c);
  }
  if (pid !== state.peer.id) {
    const conn = state.conns.get(pid);
    if (conn) sendConn(conn, { type: 'myhand', hand: state.game.hands[pid] });
  }
}
function reshuffleFromDiscard() {
  const g = state.game;
  const top = g.discardPile.pop();
  let pool = g.discardPile;
  g.discardPile = [top];
  g.deck = shuffle(pool);
}

function getName(pid) {
  const p = state.game.players.find(x => x.id === pid);
  return p ? p.name : pid;
}

// ---------- Shared UI bits ----------
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (m) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[m]));
}

window.addEventListener('beforeunload', () => {
  try { state.peer?.disconnect(); state.peer?.destroy(); } catch {}
});

(function hostSelfLoop(){
  setInterval(() => {
    if (state.isHost) refreshPlayersList();
  }, 1000);
})();

// Expose for debugging
window._state = state;
