import { ChessEngine } from './engine.js';

const $ = id => document.getElementById(id);
const glyph = { king:'♚', queen:'♛', rook:'♜', bishop:'♝', knight:'♞', pawn:'♟' };
const depth = { easy:2, medium:4, hard:6 };
const saveKey = 'quiet-chess-v1';
let game, moves = [], level = 'medium', mode = 'computer', color = 'white';
let selected = null, targets = [], focusSquare = 12, worker = null, busy = false;
let peer = null, channel = null, connected = false, roomTimer = null;
const board = $('board');
const terminal = () => ['checkmate', 'stalemate', 'draw'].includes(game.getStatus());
const notice = text => { $('notice').textContent = text; };
const roomStatus = text => { $('room-status').textContent = text; };
const squareName = n => 'abcdefgh'[n % 8] + (Math.floor(n / 8) + 1);

function validMove(move) {
  if (!move || !Number.isInteger(move.from) || !Number.isInteger(move.to) || move.from < 0 || move.from > 63 || move.to < 0 || move.to > 63) return false;
  if (move.promotion != null && !['', 'queen', 'rook', 'bishop', 'knight'].includes(move.promotion)) return false;
  const piece = game.getBoard()[move.from];
  if (!piece || piece.color !== game.getTurn()) return false;
  const promotes = piece.kind === 'pawn' && [0, 7].includes(Math.floor(move.to / 8));
  if (promotes !== Boolean(move.promotion)) return false;
  return game.getLegalMoves(move.from).some(legal => legal.to === move.to);
}

function save() {
  if (mode !== 'computer') return;
  try { localStorage.setItem(saveKey, JSON.stringify({ moves, level })); }
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

function render() {
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
        try { channel.send({ type: 'move', ply: moves.length, move: action }); }
        catch { connected = false; render(); roomStatus('Connection lost. Download the game, then create a new invite.'); }
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
  disconnect(); resetBoard(); mode = next; color = 'white'; history.replaceState(null, '', location.pathname);
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
  disconnect(); resetBoard(); color = 'white'; history.replaceState(null, '', location.pathname); notice(''); save(); render();
  if (mode === 'friend') startRoom();
};
document.querySelectorAll('[data-level]').forEach(b => b.onclick = () => { level = b.dataset.level; save(); render(); if (busy) think(); });
$('export').onclick = () => {
  const url = URL.createObjectURL(new Blob([game.getPgn()], { type:'application/x-chess-pgn' }));
  const link = document.createElement('a'); link.href = url; link.download = 'quiet-chess.pgn'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// ponytail: live two-person rooms using PeerJS public signaling/default ICE services.
// No accounts or server history; add owned signaling/TURN and persistence for reliability.
function startRoom(invitedId) {
  if (!game || mode !== 'friend') return;
  disconnect(); resetBoard(); color = invitedId ? 'black' : 'white'; focusSquare = color === 'white' ? 12 : 52; render();
  roomStatus(invitedId ? 'Connecting to your friend…' : 'Creating your invite…');
  if (!window.Peer) { roomStatus('Connection library unavailable. Reload while online and try again.'); return; }
  const id = invitedId ? undefined : 'quiet-' + crypto.randomUUID();
  const current = new window.Peer(id, { debug: 0 }); peer = current;
  let admitted = false;
  const failed = message => {
    if (peer !== current) return;
    connected = false; render(); roomStatus(message);
  };
  roomTimer = setTimeout(() => {
    if (!connected) failed(invitedId ? 'Could not connect. Ask for a fresh invite or try another network.' : 'Still waiting. Send the invite below; if none appeared, create a new link.');
  }, 25000);
  function attach(connection) {
    channel = connection;
    connection.on('open', () => {
      if (peer !== current) return;
      connected = true; clearTimeout(roomTimer); roomStatus('Connected · you play ' + color + '. Keep this tab open.'); render();
    });
    connection.on('data', data => {
      if (peer !== current || !connected) return;
      if (!data || data.type !== 'move' || data.ply !== moves.length + 1 || game.getTurn() === color || !commit(data.move)) {
        failed('The games fell out of sync. Download this game and create a fresh invite.'); connection.close();
      }
    });
    connection.on('close', () => failed('Your friend disconnected. Download the game and create a new invite to play again.'));
    connection.on('error', () => failed('Connection interrupted. Create a fresh invite or try another network.'));
  }
  current.on('open', () => {
    if (peer !== current) return;
    if (invitedId) attach(current.connect(invitedId, { reliable:true, serialization:'json' }));
    else {
      const url = new URL(location.href); url.hash = 'room=' + id;
      $('invite').value = url.href; $('invite-label').hidden = false;
      roomStatus('Invite ready. You play White; your friend plays Black.');
    }
  });
  current.on('connection', connection => {
    if (peer !== current || invitedId || admitted) { connection.on('open', () => connection.close()); return; }
    admitted = true; attach(connection);
  });
  current.on('error', () => failed('Could not reach your friend or the connection service. Try a new invite or another network.'));
  current.on('disconnected', () => { if (!connected) failed('The connection service is unavailable. Create a new invite when online.'); });
}
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
window.addEventListener('beforeunload', event => { if (mode === 'friend' && connected) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('offline', () => { $('connection').textContent = 'Offline · computer play available'; });
window.addEventListener('online', () => { $('connection').textContent = 'No account. Just chess.'; });
let installPrompt;
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('install').hidden = false; });
$('install').onclick = async () => { await installPrompt?.prompt(); $('install').hidden = true; installPrompt = null; };

try {
  game = await ChessEngine.create();
  const room = new URLSearchParams(location.hash.slice(1)).get('room');
  if (room && /^quiet-[a-f0-9-]{36}$/.test(room)) { mode = 'friend'; startRoom(room); }
  else { restore(); render(); think(); }
} catch { $('status').textContent = 'The board could not load'; $('hint').textContent = 'Reload to try again. A modern browser with WebAssembly is required.'; }
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(() => navigator.serviceWorker.ready).then(() => {
    if (mode === 'computer') $('save-status').textContent = 'Saved on this device · computer play works offline.';
  }).catch(() => notice('Offline installation unavailable. Online play still works.'));
}
