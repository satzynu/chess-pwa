import { ChessEngine } from './engine.js';

const $ = id => document.getElementById(id);
const glyph = { king:'♚', queen:'♛', rook:'♜', bishop:'♝', knight:'♞', pawn:'♟' };
const depth = { easy:2, medium:4, hard:6 };
const saveKey = 'quiet-chess-v1';
const roomKey = id => 'quiet-chess-room-v1:' + id;
const validRoomId = id => /^quiet-[a-f0-9-]{36}$/.test(id || '');
let roomSession = null;
let game, validator, moves = [], level = 'medium', mode = 'computer', color = 'white';
let wasFinished = null;
let selected = null, targets = [], focusSquare = 12, worker = null, busy = false;
let peer = null, channel = null, connected = false, roomTimer = null;
const board = $('board');
const terminal = () => ['checkmate', 'stalemate', 'draw'].includes(game.getStatus());
const notice = text => { $('notice').textContent = text; };
const roomStatus = text => { $('room-status').textContent = text; };
const squareName = n => 'abcdefgh'[n % 8] + (Math.floor(n / 8) + 1);

function validMove(move, position = game) {
  if (!move || !Number.isInteger(move.from) || !Number.isInteger(move.to) || move.from < 0 || move.from > 63 || move.to < 0 || move.to > 63) return false;
  if (move.promotion != null && !['', 'queen', 'rook', 'bishop', 'knight'].includes(move.promotion)) return false;
  const piece = position.getBoard()[move.from];
  if (!piece || piece.color !== position.getTurn()) return false;
  const promotes = piece.kind === 'pawn' && [0, 7].includes(Math.floor(move.to / 8));
  if (promotes !== Boolean(move.promotion)) return false;
  return position.getLegalMoves(move.from).some(legal => legal.to === move.to);
}

function save() {
  try {
    if (mode === 'computer') localStorage.setItem(saveKey, JSON.stringify({ moves, level }));
    else if (roomSession) localStorage.setItem(roomKey(roomSession.id), JSON.stringify({ ...roomSession, moves }));
  }
  catch { $('save-status').textContent = 'Storage unavailable. Download your game to keep it.'; }
}
function restore() {
  game.reset(); moves = [];
  try {
    const raw = localStorage.getItem(saveKey);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved.moves) || saved.moves.length > 2000) throw new Error('Invalid save');
    for (const move of saved.moves) {
      if (terminal() || !validMove(move) || !game.applyMove(move.from, move.to, move.promotion)) throw new Error('Invalid save');
      moves.push(move);
    }
    if (Object.hasOwn(depth, saved.level)) level = saved.level;
  } catch { game.reset(); moves = []; notice('The saved game could not be restored. A fresh board is ready.'); }
}
function stopAI() { worker?.terminate(); worker = null; busy = false; }
function disconnect() {
  clearTimeout(roomTimer);
  const old = peer; peer = null; channel = null; connected = false;
  old?.destroy();
  $('invite-label').hidden = true;
}
function resetBoard() { stopAI(); selected = null; targets = []; game.reset(); moves = []; }

function celebrateFinish() {
  const finished = terminal(), won = game.getStatus() === 'checkmate';
  const celebrate = finished && wasFinished === false && won;
  const result = $('game-result');
  result.hidden = !finished;
  if (finished && wasFinished !== true) {
    result.classList.toggle('draw', !won);
    $('result-title').textContent = won ? `${game.getTurn() === 'white' ? 'Black' : 'White'} wins` : 'Draw';
    $('result-detail').textContent = won ? 'Checkmate. Well played.' : game.getStatus() === 'stalemate' ? 'Stalemate · honours shared.' : 'A balanced finish · honours shared.';
    $('result-symbol').textContent = won ? '♛' : '½–½';
  }
  wasFinished = finished;
  if (!finished || !won) document.querySelector('.confetti')?.remove();
  if (!celebrate || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.querySelector('.confetti')?.remove();
  const confetti = document.createElement('div');
  confetti.className = 'confetti'; confetti.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 48; i++) {
    const piece = document.createElement('i');
    piece.style.cssText = `left:${Math.random() * 100}%;background:${['#c9db9a','#f0eee3','#e4b76b','#b6ced7'][i % 4]};--drift:${Math.random() * 240 - 120}px;--spin:${Math.random() * 900 - 450}deg;animation-delay:${Math.random() * .5}s`;
    confetti.append(piece);
  }
  document.body.append(confetti);
  setTimeout(() => confetti.remove(), 3500);
}

function render() {
  celebrateFinish();
  const pieces = game.getBoard(), turn = game.getTurn(), status = game.getStatus();
  const hadFocus = board.contains(document.activeElement);
  board.replaceChildren();
  for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
    const rank = color === 'white' ? 7 - row : row, file = color === 'white' ? col : 7 - col;
    const n = rank * 8 + file, piece = pieces[n], button = document.createElement('button');
    button.className = `square ${(rank + file) % 2 ? 'light' : 'dark'}`;
    button.dataset.square = n;
    button.tabIndex = n === focusSquare ? 0 : -1;
    button.setAttribute('aria-label', `${squareName(n)}, ${piece ? piece.color + ' ' + piece.kind : 'empty'}${targets.some(m => m.to === n) ? ', legal destination' : ''}`);
    button.setAttribute('aria-pressed', String(selected === n));
    button.classList.toggle('selected', selected === n);
    button.classList.toggle('target', targets.some(m => m.to === n));
    button.classList.toggle('occupied', Boolean(piece));
    const last = moves.at(-1);
    button.classList.toggle('last', Boolean(last && (last.from === n || last.to === n)));
    if (piece) { const span = document.createElement('span'); span.className = `piece ${piece.color}`; span.textContent = glyph[piece.kind]; span.setAttribute('aria-hidden', 'true'); button.append(span); }
    for (const [show, cls, text] of [[col === 0, 'rank', rank + 1], [row === 7, 'file', 'abcdefgh'[file]]]) {
      if (show) { const label = document.createElement('span'); label.className = `coordinate ${cls}`; label.textContent = text; label.setAttribute('aria-hidden', 'true'); button.append(label); }
    }
    board.append(button);
  }
  if (hadFocus) board.querySelector(`[data-square="${focusSquare}"]`)?.focus({ preventScroll: true });
  board.setAttribute('aria-busy', String(busy));
  const waiting = mode === 'friend' && !connected;
  $('status').textContent = terminal() ? (status === 'checkmate' ? `Checkmate · ${turn === 'white' ? 'Black' : 'White'} wins` : status === 'stalemate' ? 'Stalemate · well played' : 'Draw · well played') : waiting ? 'Waiting for your friend' : busy ? 'The computer is thinking…' : `${turn === color ? 'Your' : mode === 'computer' ? 'Computer’s' : 'Your friend’s'} move${status === 'check' ? ' · Check!' : ''}`;
  $('hint').textContent = terminal() ? 'Download the game or start a fresh one.' : waiting ? 'Share an invite link to start.' : busy ? 'Take a breath. Plan your next move.' : turn === color ? 'Select a piece, then its destination.' : 'The board will update when they move.';
  $('human-indicator').hidden = waiting || terminal() || turn !== color;
  $('computer-indicator').hidden = waiting || terminal() || turn === color;
  const players = document.querySelectorAll('.player');
  players[0].querySelector('strong').textContent = mode === 'computer' ? 'The computer' : 'Your friend';
  $('opponent-level').textContent = `${mode === 'computer' ? level[0].toUpperCase() + level.slice(1) + ' · ' : ''}${color === 'white' ? 'Black' : 'White'} pieces`;
  players[1].querySelector('div').querySelector('span').textContent = `${color === 'white' ? 'White' : 'Black'} pieces`;
  const captured = game.getCapturedPieces();
  // Engine groups captured pieces by their own color, not by the capturer.
  $('captured-white').textContent = (captured[color === 'white' ? 'black' : 'white'] || []).map(p => glyph[p]).join('');
  $('captured-black').textContent = (captured[color] || []).map(p => glyph[p]).join('');
  const history = game.getMoveHistory();
  $('history').replaceChildren();
  if (!history.length) {
    const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Every game starts with a possibility. Pick a piece to begin.'; $('history').append(empty);
  }
  for (let i = 0; i < history.length; i += 2) {
    const row = document.createElement('div'); row.className = 'move-row';
    for (const text of [Math.floor(i / 2) + 1 + '.', history[i], history[i + 1] || '—']) { const span = document.createElement('span'); span.textContent = text; row.append(span); }
    $('history').append(row);
  }
  $('history').scrollTop = $('history').scrollHeight;
  $('move-count').textContent = `${Math.ceil(history.length / 2)} moves`;
  $('undo').disabled = mode !== 'computer' || !moves.length;
  $('new-game').disabled = false;
  $('export').disabled = !moves.length;
  $('difficulty').hidden = mode !== 'computer';
  $('friend-controls').hidden = mode !== 'friend';
  $('sync-room').disabled = !roomSession;
  $('computer-mode').setAttribute('aria-pressed', String(mode === 'computer'));
  $('friend-mode').setAttribute('aria-pressed', String(mode === 'friend'));
  document.querySelectorAll('[data-level]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.level === level)));
}
function commit(move) {
  if (terminal() || !validMove(move) || !game.applyMove(move.from, move.to, move.promotion)) return false;
  moves.push({ from: move.from, to: move.to, promotion: move.promotion || '' });
  selected = null; targets = []; save(); render(); return true;
}
function think() {
  if (mode !== 'computer' || terminal() || game.getTurn() !== 'black') return;
  stopAI(); busy = true; render();
  worker = new Worker('./ai-worker.js', { type: 'module' });
  const active = worker;
  const failed = () => { if (worker !== active) return; stopAI(); render(); notice('The computer could not finish its move. Undo to try again, or start a new game.'); };
  worker.onmessage = ({ data }) => {
    if (worker !== active) return;
    if (data.error || !data.move) { failed(); return; }
    if (!validMove(data.move)) { failed(); return; }
    stopAI(); commit(data.move); render();
  };
  worker.onerror = failed;
  worker.postMessage({ moves, depth: depth[level] });
}
async function choose(n) {
  if (!game || busy || terminal() || game.getTurn() !== color || (mode === 'friend' && !connected)) return;
  focusSquare = n;
  if (selected === n) { selected = null; targets = []; render(); return; }
  const move = targets.find(m => m.to === n);
  if (move) {
    const action = { from: selected, to: n, promotion: '' };
    const piece = game.getBoard()[selected];
    if (piece.kind === 'pawn' && [0, 7].includes(Math.floor(n / 8))) {
      const dialog = $('promotion'); dialog.returnValue = ''; dialog.showModal();
      action.promotion = await new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once:true }));
      if (!action.promotion || (mode === 'friend' && !connected)) return;
    }
    if (commit(action)) {
      if (mode === 'friend') {
        connected = false; render(); roomStatus('Saving move · waiting for your friend’s confirmation…'); sendState();
      } else think();
    }
  } else {
    const piece = game.getBoard()[n];
    selected = piece?.color === color ? n : null;
    targets = selected === null ? [] : game.getLegalMoves(n); render();
  }
}
board.addEventListener('click', event => { const square = event.target.closest('[data-square]'); if (square) choose(Number(square.dataset.square)); });
board.addEventListener('keydown', event => {
  const square = event.target.closest('[data-square]'); if (!square) return;
  const n = Number(square.dataset.square), sign = color === 'white' ? 1 : -1;
  const delta = { ArrowLeft: -sign, ArrowRight: sign, ArrowUp: 8 * sign, ArrowDown: -8 * sign }[event.key];
  if (event.key === 'Escape') { selected = null; targets = []; render(); }
  if (!delta) return;
  event.preventDefault();
  const next = n + delta;
  if (next < 0 || next > 63 || (Math.abs(delta) === 1 && Math.floor(n / 8) !== Math.floor(next / 8))) return;
  focusSquare = next; board.querySelectorAll('button').forEach(b => b.tabIndex = Number(b.dataset.square) === next ? 0 : -1);
  board.querySelector(`[data-square="${next}"]`).focus();
});
$('promotion').querySelectorAll('button').forEach(b => b.onclick = () => $('promotion').close(b.value));

async function confirmLeave() {
  if (!moves.length && !peer) return true;
  const dialog = $('restart'); dialog.returnValue = ''; dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once:true }));
}
async function setMode(next) {
  if (!game || mode === next || !await confirmLeave()) return;
  disconnect(); roomSession = null; resetBoard(); mode = next; color = 'white'; history.replaceState(null, '', location.pathname);
  notice(''); roomStatus('Create a room and invite a friend.');
  if (mode === 'computer') restore();
  render(); think();
}
$('computer-mode').onclick = () => setMode('computer');
$('friend-mode').onclick = () => setMode('friend');
$('undo').onclick = () => {
  if (mode !== 'computer') return;
  stopAI(); game.undo(); moves.pop();
  if (game.getTurn() === 'black') { game.undo(); moves.pop(); }
  selected = null; targets = []; notice(''); save(); render();
};
$('new-game').onclick = async () => {
  if (!game || !await confirmLeave()) return;
  disconnect(); roomSession = null; resetBoard(); color = 'white'; history.replaceState(null, '', location.pathname); notice(''); save(); render();
  if (mode === 'friend') startRoom();
};
document.querySelectorAll('[data-level]').forEach(b => b.onclick = () => { level = b.dataset.level; save(); render(); if (busy) think(); });
$('export').onclick = () => {
  const url = URL.createObjectURL(new Blob([game.getPgn()], { type:'application/x-chess-pgn' }));
  const link = document.createElement('a'); link.href = url; link.download = 'quiet-chess.pgn'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// ponytail: browser-local room history plus prefix reconciliation, not a hosted database.
// Conflicting branches are preserved and paused rather than silently choosing a winner.
const historyKey = list => JSON.stringify(list.map(m => [m.from, m.to, m.promotion || '']));
function checkedHistory(list) {
  if (!Array.isArray(list) || list.length > 2000) throw new Error('Invalid history');
  validator.reset();
  return list.map(move => {
    if (['checkmate', 'stalemate', 'draw'].includes(validator.getStatus()) || !validMove(move, validator) || !validator.applyMove(move.from, move.to, move.promotion)) throw new Error('Invalid history');
    return { from: move.from, to: move.to, promotion: move.promotion || '' };
  });
}
function loadMoves(list) {
  const checked = checkedHistory(list);
  game.reset();
  for (const move of checked) game.applyMove(move.from, move.to, move.promotion);
  moves = checked; selected = null; targets = [];
}
function sendState() {
  if (!channel?.open) return;
  try { channel.send({ type:'state', version:2, room:roomSession.id, moves }); }
  catch { connected = false; render(); roomStatus('Connection interrupted. Your game is saved. Reconnecting…'); }
}
function startRoom(invitedId) {
  if (!game || mode !== 'friend') return;
  disconnect(); roomSession = null; resetBoard();
  const id = invitedId || 'quiet-' + crypto.randomUUID();
  let saved;
  try { saved = JSON.parse(localStorage.getItem(roomKey(id))); }
  catch { render(); roomStatus('Saved room storage is unavailable or invalid. It was not overwritten. Restore browser storage before rejoining.'); return; }
  if (saved) {
    try {
      if (saved.id !== id || !['white','black'].includes(saved.color) || typeof saved.token !== 'string' || saved.token.length > 100 || (saved.guestToken != null && (typeof saved.guestToken !== 'string' || saved.guestToken.length > 100))) throw new Error('Invalid room');
      loadMoves(saved.moves);
    } catch { roomStatus('Saved room data is invalid. It has not been overwritten. Download what you can or start a new game.'); render(); return; }
  }
  roomSession = saved ? { id, color:saved.color, token:saved.token, guestToken:saved.guestToken || null } : { id, color:invitedId ? 'black' : 'white', token:crypto.randomUUID(), guestToken:null };
  color = roomSession.color; focusSquare = color === 'white' ? 12 : 52;
  history.replaceState(null, '', location.pathname + '#room=' + id);
  save(); render(); connectRoom();
}
function connectRoom() {
  if (!roomSession || mode !== 'friend') return;
  disconnect(); selected = null; targets = []; render();
  const { id } = roomSession;
  const host = color === 'white';
  const url = new URL(location.href); url.hash = 'room=' + id;
  $('invite').value = url.href; $('invite-label').hidden = !host;
  roomStatus('Game saved · connecting and checking both boards…');
  if (!window.Peer) { roomStatus('Connection library unavailable. Reload while online; your game is saved.'); return; }
  const current = new window.Peer(host ? id : undefined, { debug:0 }); peer = current;
  let lastAck = 0, openedAt = 0, conflict = false, retryAt = 0;
  const active = connection => peer === current && channel === connection;
  const pause = message => { connected = false; render(); roomStatus(message); };
  function attach(connection) {
    channel = connection; openedAt = Date.now(); lastAck = 0;
    connection.on('open', () => {
      if (!active(connection)) return;
      pause('Connected · synchronizing saved moves…'); sendState();
    });
    connection.on('data', data => {
      if (!active(connection) || conflict) return;
      try {
        if (!data || data.version !== 2 || data.room !== id) throw new Error('Incompatible game version');
        if (data.type === 'ack') {
          if (data.key === historyKey(moves)) {
            lastAck = Date.now(); const wasConnected = connected; connected = true; if (!wasConnected) render();
            roomStatus('Connected · boards synced · you play ' + color + '.');
          }
          return;
        }
        if (data.type !== 'state') throw new Error('Invalid message');
        const remote = checkedHistory(data.moves);
        const common = Math.min(remote.length, moves.length);
        if (historyKey(remote.slice(0, common)) !== historyKey(moves.slice(0, common))) throw new Error('Conflicting move histories');
        if (remote.length > moves.length) { loadMoves(remote); save(); render(); }
        connection.send({ type:'ack', version:2, room:id, key:historyKey(moves) });
        if (remote.length !== moves.length || !connected) sendState();
      } catch {
        conflict = true;
        pause('Sync conflict or incompatible game. Your saved moves were kept. Download the game; do not start over unless both players agree.');
      }
    });
    const lost = () => {
      if (!active(connection)) return;
      channel = null; connection.close();
      pause('Friend disconnected · game saved. Reconnecting automatically…');
    };
    connection.on('close', lost); connection.on('error', lost);
  }
  function join() {
    if (host || !current.open || channel || conflict) return;
    attach(current.connect(id, { reliable:true, serialization:'json', metadata:{ version:2, token:roomSession.token } }));
  }
  current.on('open', () => {
    if (peer !== current) return;
    if (host) roomStatus('Invite ready · game saved. Waiting for your friend to reconnect or join.');
    else join();
  });
  current.on('connection', connection => {
    if (peer !== current || !host || channel || conflict || connection.metadata?.version !== 2 || typeof connection.metadata?.token !== 'string' || connection.metadata.token.length > 100 || (roomSession.guestToken && roomSession.guestToken !== connection.metadata.token)) {
      connection.on('open', () => connection.close()); return;
    }
    roomSession.guestToken = connection.metadata.token; save(); attach(connection);
  });
  current.on('error', error => {
    if (peer !== current || conflict) return;
    if (error.type === 'unavailable-id') {
      pause('Room is still open in another tab or releasing its connection. Close duplicate tabs; retrying…'); retryAt = Date.now() + 3000;
    } else {
      pause('Connection unavailable · your game is saved. Retrying…');
      if (channel && !channel.open) { const old = channel; channel = null; old.close(); }
    }
  });
  current.on('disconnected', () => { if (peer === current && !connected) pause('Connection service unavailable · your game is saved. Retrying…'); });
  roomTimer = setInterval(() => {
    if (peer !== current || conflict) return;
    if (retryAt && Date.now() >= retryAt) { connectRoom(); return; }
    if (current.disconnected && !current.destroyed) { current.reconnect(); return; }
    if (channel?.open) {
      if (Date.now() - (lastAck || openedAt) > 12000) pause('Waiting for sync confirmation · game saved. Use Reconnect if this persists.');
      sendState();
    } else if (channel && Date.now() - openedAt > 12000) {
      const old = channel; channel = null; old.close(); join();
    } else join();
  }, 3000);
}
$('sync-room').onclick = () => connectRoom();
$('create-room').onclick = async () => { if (await confirmLeave()) { history.replaceState(null, '', location.pathname); startRoom(); } };
$('copy-invite').onclick = async () => {
  try { await navigator.clipboard.writeText($('invite').value); roomStatus('Link copied. Send it to your friend.'); }
  catch { $('invite').select(); roomStatus('Select and copy the invite link above.'); }
};
window.addEventListener('hashchange', async () => {
  const room = new URLSearchParams(location.hash.slice(1)).get('room');
  if (!game || !room || !/^quiet-[a-f0-9-]{36}$/.test(room) || !await confirmLeave()) return;
  mode = 'friend'; startRoom(room);
});
window.addEventListener('pagehide', disconnect);
window.addEventListener('pageshow', event => { if (event.persisted && roomSession) connectRoom(); });
window.addEventListener('offline', () => { $('connection').textContent = 'Offline · computer play available'; });
window.addEventListener('online', () => { $('connection').textContent = 'No account. Just chess.'; });
let installPrompt;
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('install').hidden = false; });
$('install').onclick = async () => { await installPrompt?.prompt(); $('install').hidden = true; installPrompt = null; };

try {
  game = await ChessEngine.create(); validator = await ChessEngine.create();
  const room = new URLSearchParams(location.hash.slice(1)).get('room');
  if (room && /^quiet-[a-f0-9-]{36}$/.test(room)) { mode = 'friend'; startRoom(room); }
  else { restore(); render(); think(); }
} catch { $('status').textContent = 'The board could not load'; $('hint').textContent = 'Reload to try again. A modern browser with WebAssembly is required.'; }
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(() => navigator.serviceWorker.ready).then(() => {
    if (mode === 'computer') $('save-status').textContent = 'Saved on this device · computer play works offline.';
  }).catch(() => notice('Offline installation unavailable. Online play still works.'));
}
