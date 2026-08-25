import { Chess } from 'chess.js';
import { setupScene, orientCameraForColor } from './scene/setupScene.js';
import { buildBoard, showSelectMarker, showMoveMarkers, clearHighlights } from './scene/board.js';
import { buildCoordinateLabels } from './scene/coordinateLabels.js';
import { loadPieceModels } from './scene/assetLoader.js';
import { PieceManager } from './scene/pieceManager.js';
import { CinematicCamera } from './scene/cinematicCamera.js';
import { Picker } from './interaction/picker.js';
import { requestAIMove } from './ai/ai.js';
import { UI } from './ui/ui.js';
import { connectSocket, emitAck } from './network/socket.js';

const canvas = document.getElementById('canvas');
const { scene, camera, renderer, controls, composer, defaultCameraPos } = setupScene(canvas);
const { tileMeshes, markerMeshes } = buildBoard(scene);
buildCoordinateLabels(scene);
const pieceManager = new PieceManager(scene);
const cinematicCamera = new CinematicCamera(camera, controls);
const picker = new Picker(camera, renderer.domElement, Object.values(tileMeshes));

let chess = new Chess();
let selectedSquare = null;
let inputLocked = true;
let aiLevel = 'squire';
let gameMode = 'ai'; // 'ai' | 'online' | 'spectator'
let myColor = 'w';
let modelsReady = false;
let onlineGameEnded = false;

// ── Session persistence (survives a refresh or a dropped connection) ──

const SESSION_KEY = 'gambit_session';

function saveSession(code, token) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, token }));
}

function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

const ui = new UI({
  onNewGame: () => {
    if (gameMode !== 'ai') return; // online: use "Request Rematch"; spectator: nothing to reset
    chess = new Chess();
    selectedSquare = null;
    inputLocked = false;
    pieceManager.buildFromBoard(chess);
    clearHighlights(markerMeshes);
    ui.setTurn(chess.turn());
    ui.setStatus('');
    ui.renderHistory([]);
  },
  onDifficultyChange: (level) => { aiLevel = level; },
});
ui.setStatus('Loading pieces…');

loadPieceModels().then(() => {
  modelsReady = true;
});

function updateStatusAfterMove() {
  ui.renderHistory(chess.history());
  if (chess.isCheckmate()) {
    const winner = chess.turn() === 'w' ? 'Black' : 'White';
    ui.setStatus(`Checkmate — ${winner} wins.`);
    onGameEnded();
  } else if (chess.isStalemate()) {
    ui.setStatus('Stalemate — draw.');
    onGameEnded();
  } else if (chess.isDraw()) {
    ui.setStatus('Draw.');
    onGameEnded();
  } else if (chess.isCheck()) {
    ui.setStatus('Check.');
  } else {
    ui.setStatus('');
  }
  ui.setTurn(chess.turn());
}

function playMove(moveObj, { isRemote = false } = {}) {
  const moveResult = chess.move(moveObj);
  if (!moveResult) return null;

  if (gameMode === 'online' && !isRemote) {
    emitAck('make-move', { from: moveResult.from, to: moveResult.to, promotion: moveResult.promotion });
  }

  inputLocked = true;

  // The piece animation and the cinematic camera run concurrently once a
  // capture lands — both must finish before input unlocks, so a player
  // can't act while the camera is still mid-swing.
  let pieceDone = false;
  let cameraDone = true;
  const tryUnlock = () => {
    if (!pieceDone || !cameraDone) return;
    if (chess.isGameOver() || onlineGameEnded) return;
    if (chess.turn() === myColor) {
      inputLocked = false;
    } else if (gameMode === 'ai') {
      triggerAIMove();
    }
    // else (online, opponent's turn): stay locked until their move arrives.
  };

  pieceManager.animateMove(moveResult, {
    onCaptureImpact: (worldPos) => {
      cameraDone = false;
      const pos = worldPos.clone();
      pos.y = 0.5;
      cinematicCamera.playCapture(pos, () => { cameraDone = true; tryUnlock(); });
    },
    onComplete: () => {
      updateStatusAfterMove();
      pieceDone = true;
      tryUnlock();
    },
  });

  return moveResult;
}

function triggerAIMove() {
  inputLocked = true;
  ui.setTurn(chess.turn(), true);
  requestAIMove(chess, aiLevel, (san) => {
    if (!san) { inputLocked = false; return; }
    playMove(san);
  });
}

// ── Board interaction ──────────────────────────────────────────────

renderer.domElement.addEventListener('click', (event) => {
  if (gameMode === 'spectator') return;
  if (inputLocked || onlineGameEnded || chess.isGameOver() || chess.turn() !== myColor) return;

  const square = picker.pickSquare(event);
  if (!square) return;

  const piece = chess.get(square);

  const select = (sq) => {
    selectedSquare = sq;
    clearHighlights(markerMeshes);
    showSelectMarker(markerMeshes, sq);
    showMoveMarkers(markerMeshes, chess.moves({ square: sq, verbose: true }).map((m) => m.to));
  };

  if (!selectedSquare) {
    if (piece && piece.color === myColor) select(square);
    return;
  }

  if (square === selectedSquare) {
    selectedSquare = null;
    clearHighlights(markerMeshes);
    return;
  }

  const legalMoves = chess.moves({ square: selectedSquare, verbose: true });
  const target = legalMoves.find((m) => m.to === square);

  if (target) {
    clearHighlights(markerMeshes);
    selectedSquare = null;
    let promotion;
    if (target.piece === 'p' && (square[1] === '8' || square[1] === '1')) promotion = 'q';
    playMove({ from: target.from, to: target.to, promotion });
    return;
  }

  if (piece && piece.color === myColor) {
    select(square);
  } else {
    selectedSquare = null;
    clearHighlights(markerMeshes);
  }
});

// ── Clocks ──────────────────────────────────────────────────────────

const clocksEl = document.getElementById('clocks');
const clockMeEl = document.getElementById('clock-me');
const clockOppEl = document.getElementById('clock-opponent');

let clockState = null; // { w, b } ms, or null if untimed
let clockSyncedAt = 0;
let clockInterval = null;

function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function syncClocks(clocks) {
  clockState = clocks;
  clockSyncedAt = Date.now();
  if (!clocks) {
    clocksEl.classList.add('hidden');
    if (clockInterval) { clearInterval(clockInterval); clockInterval = null; }
    return;
  }
  clocksEl.classList.remove('hidden');
  if (!clockInterval) clockInterval = setInterval(tickClocks, 250);
  tickClocks();
}

function tickClocks() {
  if (!clockState) return;
  const elapsed = Date.now() - clockSyncedAt;
  const turn = chess.turn();
  const live = { w: clockState.w, b: clockState.b };
  if (!chess.isGameOver() && !onlineGameEnded) live[turn] = Math.max(0, clockState[turn] - elapsed);

  const oppColor = myColor === 'w' ? 'b' : 'w';
  clockMeEl.textContent = formatClock(live[myColor]);
  clockOppEl.textContent = formatClock(live[oppColor]);
  clockMeEl.classList.toggle('clock-active', turn === myColor);
  clockOppEl.classList.toggle('clock-active', turn === oppColor);
  clockMeEl.classList.toggle('clock-low', live[myColor] < 20000);
  clockOppEl.classList.toggle('clock-low', live[oppColor] < 20000);
}

// ── Resign / rematch ────────────────────────────────────────────────

const resignBtn = document.getElementById('resign-btn');
const rematchBtn = document.getElementById('rematch-btn');

function onGameEnded() {
  onlineGameEnded = true;
  inputLocked = true;
  if (gameMode === 'online') {
    clearSession();
    resignBtn.classList.add('hidden');
    rematchBtn.classList.remove('hidden');
    rematchBtn.textContent = 'Request Rematch';
    rematchBtn.disabled = false;
  }
}

resignBtn.addEventListener('click', async () => {
  if (gameMode !== 'online' || onlineGameEnded) return;
  await emitAck('resign', {});
});

rematchBtn.addEventListener('click', async () => {
  rematchBtn.disabled = true;
  rematchBtn.textContent = 'Waiting for opponent…';
  await emitAck('request-rematch', {});
});

// ── Menu / game start ──────────────────────────────────────────────

const menuScreen = document.getElementById('menu-screen');
const uiRoot = document.getElementById('ui');
const menuHome = document.getElementById('menu-home');
const menuOnline = document.getElementById('menu-online');
const menuWaiting = document.getElementById('menu-waiting');
const onlineError = document.getElementById('online-error');
const opponentInfo = document.getElementById('opponent-info');
const lobbyListEl = document.getElementById('lobby-list');

function showMenuView(view) {
  [menuHome, menuOnline, menuWaiting].forEach((v) => v.classList.add('hidden'));
  view.classList.remove('hidden');
  onlineError.textContent = '';
  if (view === menuOnline) startLobbyPolling(); else stopLobbyPolling();
}

function waitForModels() {
  if (modelsReady) return Promise.resolve();
  return new Promise((resolve) => {
    const check = setInterval(() => {
      if (modelsReady) { clearInterval(check); resolve(); }
    }, 50);
  });
}

async function startGame({ mode, color, state }) {
  await waitForModels();
  stopLobbyPolling();
  gameMode = mode;
  myColor = color;
  onlineGameEnded = false;

  chess = new Chess();
  if (state?.history?.length) {
    for (const san of state.history) chess.move(san);
  } else if (state?.fen) {
    chess = new Chess(state.fen);
  }

  selectedSquare = null;
  clearHighlights(markerMeshes);
  orientCameraForColor(camera, controls, defaultCameraPos, myColor);
  pieceManager.buildFromBoard(chess);
  ui.renderHistory(chess.history());
  ui.setStatus('');
  ui.setTurn(chess.turn());
  syncClocks(state?.clocks || null);

  menuScreen.classList.add('hidden');
  uiRoot.classList.remove('hidden');

  const online = mode === 'online';
  const spectating = mode === 'spectator';
  opponentInfo.classList.toggle('hidden', mode === 'ai');
  opponentInfo.textContent = spectating ? describeMatch(state) : describeOpponent(state);
  resignBtn.classList.toggle('hidden', !online);
  document.getElementById('difficulty-select').classList.toggle('hidden', online || spectating);
  document.getElementById('new-game').classList.toggle('hidden', spectating);
  rematchBtn.classList.add('hidden');

  if (mode === 'ai' && chess.turn() !== myColor) {
    triggerAIMove();
  } else {
    inputLocked = spectating || chess.turn() !== myColor;
  }
}

document.getElementById('menu-play-ai').addEventListener('click', () => {
  startGame({ mode: 'ai', color: 'w' });
});

document.getElementById('menu-play-online').addEventListener('click', () => {
  showMenuView(menuOnline);
  ensureSocket();
});

document.getElementById('menu-back').addEventListener('click', () => {
  showMenuView(menuHome);
});

let socket = null;
let lobbyPollTimer = null;

function ensureSocket() {
  if (socket) return socket;
  socket = connectSocket();
  setupSocketListeners();
  return socket;
}

function setupSocketListeners() {
  socket.on('opponent-joined', ({ state }) => {
    startGame({ mode: 'online', color: myColor, state });
  });

  socket.on('move-made', ({ move, fen, clocks }) => {
    if (chess.fen() !== fen) {
      playMove({ from: move.from, to: move.to, promotion: move.promotion }, { isRemote: true });
    }
    syncClocks(clocks); // re-sync to the server-authoritative time either way
  });

  socket.on('game-over', ({ reason, winner }) => {
    if (reason === 'timeout' && gameMode !== 'spectator') {
      const won = winner === myColor;
      ui.setStatus(won ? 'Opponent ran out of time — you win.' : 'You ran out of time — you lose.');
    }
    onGameEnded();
  });

  // A dropped connection doesn't end the game — the server holds the seat
  // open for a reconnect window. Only `opponent-left` (grace period
  // expired) actually ends it.
  socket.on('opponent-disconnected', () => {
    if (gameMode === 'online') ui.setStatus('Opponent disconnected — waiting for them to reconnect…');
  });

  socket.on('opponent-reconnected', () => {
    if (gameMode === 'online' && !onlineGameEnded) updateStatusAfterMove();
  });

  socket.on('opponent-left', () => {
    ui.setStatus('Your opponent left the game.');
    onGameEnded();
  });

  socket.on('opponent-resigned', ({ color }) => {
    ui.setStatus(color === myColor ? 'You resigned.' : 'Your opponent resigned — you win.');
    onGameEnded();
  });

  socket.on('rematch-requested', () => {
    if (gameMode !== 'online') return;
    rematchBtn.classList.remove('hidden');
    rematchBtn.disabled = false;
    rematchBtn.textContent = 'Accept Rematch';
  });

  socket.on('rematch-started', ({ state }) => {
    if (gameMode !== 'online') return;
    myColor = myColor === 'w' ? 'b' : 'w'; // server always swaps colors on rematch
    startGame({ mode: 'online', color: myColor, state });
  });
}

function describeOpponent(state) {
  const opp = myColor === 'w' ? state.players.b : state.players.w;
  return opp ? `Playing against ${opp.name}` : '';
}

function describeMatch(state) {
  const w = state.players.w?.name || 'White';
  const b = state.players.b?.name || 'Black';
  return `Watching: ${w} vs ${b}`;
}

function startLobbyPolling() {
  refreshLobbyList();
  if (lobbyPollTimer) return;
  lobbyPollTimer = setInterval(refreshLobbyList, 4000);
}

function stopLobbyPolling() {
  if (lobbyPollTimer) { clearInterval(lobbyPollTimer); lobbyPollTimer = null; }
}

async function refreshLobbyList() {
  const s = ensureSocket();
  if (!s.connected) return;
  const list = await emitAck('list-lobbies', {});
  renderLobbyList(list || []);
}

function renderLobbyList(list) {
  if (!list.length) {
    lobbyListEl.innerHTML = '<div class="lobby-list-empty">No open games right now.</div>';
    return;
  }
  lobbyListEl.innerHTML = '';
  list.forEach((l) => {
    const meta = l.joinable
      ? `${l.code} · ${escapeHtml(l.timeControl)}`
      : `${l.code} · ${escapeHtml(l.timeControl)} · ${l.spectators} watching`;
    const row = document.createElement('div');
    row.className = 'lobby-row';
    row.innerHTML = `
      <div class="lobby-row-info">
        <div class="lobby-row-host">${escapeHtml(l.hostName)}${l.hasPassword ? ' 🔒' : ''}</div>
        <div class="lobby-row-meta">${meta}</div>
      </div>
      <button class="lobby-row-join">${l.joinable ? 'Join' : 'Watch'}</button>
    `;
    row.querySelector('.lobby-row-join').addEventListener('click', () => {
      if (l.joinable) {
        document.getElementById('join-code').value = l.code;
        if (l.hasPassword) document.getElementById('join-password').focus();
        else document.getElementById('join-submit').click();
      } else {
        spectateLobby(l.code);
      }
    });
    lobbyListEl.appendChild(row);
  });
}

async function spectateLobby(code) {
  ensureSocket();
  const res = await emitAck('spectate-lobby', { code });
  if (!res.ok) { onlineError.textContent = res.error || 'Could not watch that game.'; return; }
  startGame({ mode: 'spectator', color: 'w', state: res.state });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

document.getElementById('host-create').addEventListener('click', async () => {
  const name = document.getElementById('host-name').value.trim() || 'Host';
  const password = document.getElementById('host-password').value.trim();
  const timeControl = document.getElementById('host-timecontrol').value;

  ensureSocket();

  const res = await emitAck('create-lobby', { name, password, timeControl });
  if (!res.ok) { onlineError.textContent = res.error || 'Could not create lobby.'; return; }

  myColor = res.color;
  saveSession(res.code, res.token);
  document.getElementById('lobby-code-display').textContent = res.code;
  document.getElementById('lobby-status').textContent = 'Waiting for an opponent to join…';
  showMenuView(menuWaiting);
});

document.getElementById('join-submit').addEventListener('click', async () => {
  const name = document.getElementById('join-name').value.trim() || 'Guest';
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  const password = document.getElementById('join-password').value.trim();
  if (!code) { onlineError.textContent = 'Enter a room code.'; return; }

  ensureSocket();

  const res = await emitAck('join-lobby', { code, name, password });
  if (!res.ok) { onlineError.textContent = res.error || 'Could not join lobby.'; return; }

  saveSession(res.code, res.token);
  startGame({ mode: 'online', color: res.color, state: res.state });
});

document.getElementById('lobby-cancel').addEventListener('click', () => {
  if (socket) socket.disconnect();
  socket = null;
  clearSession();
  showMenuView(menuOnline);
});

// Reattaches to a game already in progress after a refresh or a dropped
// connection, using the token saved at create/join time. Runs once at
// startup, before the menu is meaningfully interactive.
async function tryRejoin() {
  const session = loadSession();
  if (!session) return;

  ensureSocket();
  const res = await emitAck('rejoin-lobby', { code: session.code, token: session.token });
  if (!res.ok) { clearSession(); return; }

  startGame({ mode: 'online', color: res.color, state: res.state });
}
tryRejoin();

// ── Debug hook ──────────────────────────────────────────────────────

window.__gambit = {
  getFen: () => chess.fen(),
  getHistory: () => chess.history(),
  isGameOver: () => chess.isGameOver(),
  turn: () => chess.turn(),
  playMove,
  startAIGame: () => startGame({ mode: 'ai', color: 'w' }),
  forceCaptureIfAvailable: () => {
    const moves = chess.moves({ verbose: true });
    const cap = moves.find((m) => m.captured);
    if (cap) { playMove(cap.san); return cap.san; }
    return null;
  },
  inspectFacing: () => {
    const out = [];
    for (const [square, mesh] of pieceManager.meshes) {
      const lock = mesh.userData.facingLock;
      out.push({
        square,
        type: mesh.userData.pieceType,
        color: mesh.userData.pieceColor,
        rotationY: lock ? lock.rotationY : mesh.rotation.y,
      });
    }
    return out;
  },
};

function animate(now) {
  requestAnimationFrame(animate);
  controls.update();
  pieceManager.tick(now);
  composer.render();
}
requestAnimationFrame(animate);
