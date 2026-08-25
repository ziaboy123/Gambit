import { Chess } from 'chess.js';
import { setupScene, orientCameraForColor } from './scene/setupScene.js';
import { buildBoard, showSelectMarker, showMoveMarkers, clearHighlights, squareToPosition } from './scene/board.js';
import { buildCoordinateLabels } from './scene/coordinateLabels.js';
import { loadPieceModels } from './scene/assetLoader.js';
import { PieceManager } from './scene/pieceManager.js';
import { CinematicCamera } from './scene/cinematicCamera.js';
import { Picker } from './interaction/picker.js';
import { requestAIMove } from './ai/ai.js';
import { analyzeGame } from './ai/analysis.js';
import { UI } from './ui/ui.js';
import { connectSocket, disconnectSocket, emitAck } from './network/socket.js';
import { register, login, clearToken, fetchMe, fetchLeaderboard, fetchHistory, fetchGame } from './network/auth.js';
import { fetchDailyPuzzle, submitPuzzleAttempt } from './network/puzzle.js';
import { THEMES, getTheme, setTheme } from './scene/themes.js';
import { setTrimColor } from './scene/pieces.js';

const activeTheme = getTheme();
setTrimColor(activeTheme.board.inlayColor);
const canvas = document.getElementById('canvas');
const { scene, camera, renderer, controls, composer, defaultCameraPos } = setupScene(canvas, activeTheme);
const { tileMeshes, markerMeshes } = buildBoard(scene, activeTheme);
buildCoordinateLabels(scene);
const pieceManager = new PieceManager(scene);
const cinematicCamera = new CinematicCamera(camera, controls);
const picker = new Picker(camera, renderer.domElement, Object.values(tileMeshes));

let chess = new Chess();
let selectedSquare = null;
let inputLocked = true;
let aiLevel = 'squire';
let gameMode = 'ai'; // 'ai' | 'online' | 'spectator' | 'replay' | 'puzzle'
let myColor = 'w';
let modelsReady = false;
let onlineGameEnded = false;
let puzzleState = null; // { id, movesSoFar: [uci,...] } while gameMode === 'puzzle'
let pendingPuzzleAdvance = null; // set right before a puzzle move animates, consumed once it lands

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

// Scans the board for a color's king, for the victory cinematic to zoom in on.
function findKingSquare(color) {
  const board = chess.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = board[r][f];
      if (piece && piece.type === 'k' && piece.color === color) {
        return 'abcdefgh'[f] + (8 - r);
      }
    }
  }
  return null;
}

function updateStatusAfterMove() {
  ui.renderHistory(chess.history());
  if (chess.isCheckmate()) {
    const winnerColor = chess.turn() === 'w' ? 'b' : 'w';
    const winner = winnerColor === 'w' ? 'White' : 'Black';
    ui.setStatus(`Checkmate — ${winner} wins.`);
    onGameEnded();
    const kingSquare = findKingSquare(winnerColor);
    if (kingSquare) {
      const kingPos = squareToPosition(kingSquare);
      kingPos.y = 0.9; // roughly crown height on the king model, not board level
      cinematicCamera.playVictory(kingPos);
    }
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
    if (gameMode === 'puzzle' && pendingPuzzleAdvance) {
      const advance = pendingPuzzleAdvance;
      pendingPuzzleAdvance = null;
      advance();
      return;
    }
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
    if (gameMode === 'puzzle') {
      attemptPuzzleMove(target.from, target.to, promotion);
    } else {
      playMove({ from: target.from, to: target.to, promotion });
    }
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
const menuAuth = document.getElementById('menu-auth');
const menuLeaderboard = document.getElementById('menu-leaderboard');
const menuHistory = document.getElementById('menu-history');
const onlineError = document.getElementById('online-error');
const opponentInfo = document.getElementById('opponent-info');
const lobbyListEl = document.getElementById('lobby-list');

const ALL_MENU_VIEWS = [menuHome, menuOnline, menuWaiting, menuAuth, menuLeaderboard, menuHistory];

function showMenuView(view) {
  ALL_MENU_VIEWS.forEach((v) => v.classList.add('hidden'));
  view.classList.remove('hidden');
  onlineError.textContent = '';
  if (view === menuOnline) startLobbyPolling(); else stopLobbyPolling();
}

// ── Account ──────────────────────────────────────────────────────────

let currentUser = null; // { id, username } | null

const accountGuest = document.getElementById('account-guest');
const accountLoggedIn = document.getElementById('account-loggedin');
const accountUsername = document.getElementById('account-username');
const menuHistoryBtn = document.getElementById('menu-history-btn');

function setCurrentUser(user) {
  currentUser = user;
  accountGuest.classList.toggle('hidden', !!user);
  accountLoggedIn.classList.toggle('hidden', !user);
  menuHistoryBtn.classList.toggle('hidden', !user);
  if (user) {
    accountUsername.textContent = user.username;
    document.getElementById('host-name').value = user.username;
    document.getElementById('join-name').value = user.username;
  }
}

async function restoreSession() {
  const res = await fetchMe();
  if (res.ok) setCurrentUser(res.data.user);
}
restoreSession();

document.getElementById('account-login-btn').addEventListener('click', () => {
  setAuthMode('login');
  showMenuView(menuAuth);
});

document.getElementById('account-logout-btn').addEventListener('click', () => {
  clearToken();
  setCurrentUser(null);
});

let authMode = 'login';
const authTitle = document.getElementById('auth-title');
const authSubmit = document.getElementById('auth-submit');
const authToggle = document.getElementById('auth-toggle');
const authError = document.getElementById('auth-error');

function setAuthMode(mode) {
  authMode = mode;
  const isLogin = mode === 'login';
  authTitle.textContent = isLogin ? 'Log In' : 'Register';
  authSubmit.textContent = isLogin ? 'Log In' : 'Create Account';
  authToggle.textContent = isLogin ? 'Need an account? Register' : 'Already have an account? Log in';
  authError.textContent = '';
}

authToggle.addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));

authSubmit.addEventListener('click', async () => {
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;
  if (!username || !password) { authError.textContent = 'Enter a username and password.'; return; }

  const res = authMode === 'login' ? await login(username, password) : await register(username, password);
  if (!res.ok) { authError.textContent = res.error; return; }

  setCurrentUser(res.data.user);
  document.getElementById('auth-username').value = '';
  document.getElementById('auth-password').value = '';
  showMenuView(menuHome);
});

document.getElementById('auth-back').addEventListener('click', () => showMenuView(menuHome));

// ── Leaderboard ──────────────────────────────────────────────────────

const leaderboardList = document.getElementById('leaderboard-list');
const leaderboardTimeControl = document.getElementById('leaderboard-timecontrol');

document.getElementById('menu-leaderboard-btn').addEventListener('click', () => {
  showMenuView(menuLeaderboard);
  refreshLeaderboard();
});
document.getElementById('leaderboard-back').addEventListener('click', () => showMenuView(menuHome));
leaderboardTimeControl.addEventListener('change', refreshLeaderboard);

async function refreshLeaderboard() {
  leaderboardList.innerHTML = '<div class="ranked-empty">Loading…</div>';
  const res = await fetchLeaderboard(leaderboardTimeControl.value);
  const list = res.ok ? res.data : [];
  if (!list.length) {
    leaderboardList.innerHTML = '<div class="ranked-empty">No rated games yet for this time control.</div>';
    return;
  }
  leaderboardList.innerHTML = '';
  list.forEach((row, i) => {
    const el = document.createElement('div');
    el.className = 'ranked-row';
    el.innerHTML = `
      <span class="ranked-rank">${i + 1}</span>
      <span class="ranked-name">${escapeHtml(row.username)}</span>
      <span class="ranked-meta">${row.gamesPlayed} games</span>
      <span class="ranked-elo">${row.elo}</span>
    `;
    leaderboardList.appendChild(el);
  });
}

// ── Match history / replay ──────────────────────────────────────────

const historyList = document.getElementById('history-list');

menuHistoryBtn.addEventListener('click', () => {
  showMenuView(menuHistory);
  refreshHistory();
});
document.getElementById('history-back').addEventListener('click', () => showMenuView(menuHome));

async function refreshHistory() {
  if (!currentUser) return;
  historyList.innerHTML = '<div class="ranked-empty">Loading…</div>';
  const res = await fetchHistory(currentUser.id);
  const list = res.ok ? res.data : [];
  if (!list.length) {
    historyList.innerHTML = '<div class="ranked-empty">No games played yet.</div>';
    return;
  }
  historyList.innerHTML = '';
  list.forEach((row) => {
    const delta = row.rated ? row.ratingAfter - row.ratingBefore : null;
    const el = document.createElement('div');
    el.className = 'ranked-row clickable';
    el.innerHTML = `
      <span class="ranked-outcome outcome-${row.outcome}">${row.outcome}</span>
      <span class="ranked-name">vs ${escapeHtml(row.opponent)}</span>
      <span class="ranked-meta">${escapeHtml(row.timeControl)} · ${row.result}</span>
      <span class="ranked-elo">${row.rated ? `${delta >= 0 ? '+' : ''}${delta}` : '—'}</span>
    `;
    el.addEventListener('click', () => openReplay(row.id));
    historyList.appendChild(el);
  });
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
  if (mode !== 'ai') opponentInfo.textContent = spectating ? describeMatch(state) : describeOpponent(state);
  resignBtn.classList.toggle('hidden', !online);
  document.getElementById('difficulty-select').classList.toggle('hidden', online || spectating);
  document.getElementById('new-game').classList.toggle('hidden', spectating);
  document.getElementById('replay-controls').classList.add('hidden');
  document.getElementById('puzzle-exit').classList.add('hidden');
  rematchBtn.classList.add('hidden');

  if (mode === 'ai' && chess.turn() !== myColor) {
    triggerAIMove();
  } else {
    inputLocked = spectating || chess.turn() !== myColor;
  }
}

// ── Replay ───────────────────────────────────────────────────────────

let replayMoves = [];
let replayIndex = 0;
let gameAnalysis = null; // array from analyzeGame(), or null if not analyzed yet

const analysisStatusEl = document.getElementById('analysis-status');
const analyzeBtn = document.getElementById('replay-analyze');

async function openReplay(gameId) {
  const res = await fetchGame(gameId);
  if (!res.ok) return;
  const game = res.data;

  await waitForModels();
  stopLobbyPolling();
  gameMode = 'replay';
  myColor = 'w';
  onlineGameEnded = false;
  inputLocked = true;
  replayMoves = game.moves;
  replayIndex = replayMoves.length;
  gameAnalysis = null;
  analysisStatusEl.classList.add('hidden');
  analyzeBtn.disabled = false;
  analyzeBtn.textContent = 'Analyze';

  orientCameraForColor(camera, controls, defaultCameraPos, 'w');
  syncClocks(null);

  menuScreen.classList.add('hidden');
  uiRoot.classList.remove('hidden');
  opponentInfo.classList.remove('hidden');
  opponentInfo.textContent = `${game.whiteName} vs ${game.blackName}`;
  resignBtn.classList.add('hidden');
  document.getElementById('difficulty-select').classList.add('hidden');
  document.getElementById('new-game').classList.add('hidden');
  rematchBtn.classList.add('hidden');
  document.getElementById('puzzle-exit').classList.add('hidden');
  document.getElementById('replay-controls').classList.remove('hidden');

  renderReplayPosition();
}

function renderReplayPosition() {
  chess = new Chess();
  for (let i = 0; i < replayIndex; i++) chess.move(replayMoves[i]);
  pieceManager.buildFromBoard(chess);
  clearHighlights(markerMeshes);
  renderMoveList();
  ui.setTurn(chess.turn());
  ui.setStatus('');
  document.getElementById('replay-position').textContent = `${replayIndex} / ${replayMoves.length}`;
  document.getElementById('replay-prev').disabled = replayIndex === 0;
  document.getElementById('replay-next').disabled = replayIndex === replayMoves.length;
}

// Plain move list normally; once `gameAnalysis` is populated, each move
// gets a quality badge (Best/Good/Blunder/etc) instead.
function renderMoveList() {
  if (!gameAnalysis) { ui.renderHistory(chess.history()); return; }

  const moveListEl = document.getElementById('move-list');
  moveListEl.innerHTML = '';
  for (let i = 0; i < replayMoves.length; i += 2) {
    const li = document.createElement('li');
    const pair = document.createElement('div');
    pair.className = 'move-pair';
    pair.appendChild(moveBadge(replayMoves[i], gameAnalysis[i]));
    if (replayMoves[i + 1]) pair.appendChild(moveBadge(replayMoves[i + 1], gameAnalysis[i + 1]));
    li.appendChild(pair);
    moveListEl.appendChild(li);
  }
}

function moveBadge(san, analysis) {
  const wrap = document.createElement('span');
  wrap.textContent = san + ' ';
  if (analysis && analysis.label !== 'Good') {
    const badge = document.createElement('span');
    badge.className = `move-quality quality-${analysis.className}`;
    badge.textContent = analysis.label;
    wrap.appendChild(badge);
  }
  return wrap;
}

analyzeBtn.addEventListener('click', async () => {
  analyzeBtn.disabled = true;
  analysisStatusEl.classList.remove('hidden');
  analysisStatusEl.textContent = `Analyzing… 0 / ${replayMoves.length}`;

  gameAnalysis = await analyzeGame(replayMoves, {
    onProgress: (done, total) => { analysisStatusEl.textContent = `Analyzing… ${done} / ${total}`; },
  });

  analysisStatusEl.textContent = 'Analysis complete.';
  analyzeBtn.textContent = 'Re-analyze';
  analyzeBtn.disabled = false;
  renderMoveList();
});

document.getElementById('replay-prev').addEventListener('click', () => {
  if (replayIndex > 0) { replayIndex--; renderReplayPosition(); }
});
document.getElementById('replay-next').addEventListener('click', () => {
  if (replayIndex < replayMoves.length) { replayIndex++; renderReplayPosition(); }
});
document.getElementById('replay-exit').addEventListener('click', () => {
  document.getElementById('replay-controls').classList.add('hidden');
  uiRoot.classList.add('hidden');
  menuScreen.classList.remove('hidden');
  showMenuView(menuHistory);
  refreshHistory();
});

document.getElementById('menu-play-ai').addEventListener('click', () => {
  startGame({ mode: 'ai', color: 'w' });
});

document.getElementById('menu-play-online').addEventListener('click', () => {
  showMenuView(menuOnline);
  ensureSocket();
});

// ── Daily puzzle ────────────────────────────────────────────────────
// A single-player scripted position: the server holds the solution and
// only ever reveals the next opponent reply one ply at a time, after the
// solver has submitted a correct move for the ply before it — so a wrong
// guess never leaks the answer.

function puzzleObjectiveText(puzzle) {
  const side = myColor === 'w' ? 'White' : 'Black';
  const already = puzzle.solved ? ' (solved today)' : '';
  return `Daily Puzzle — ${puzzle.theme} — ${side} to move${already}`;
}

async function startPuzzle() {
  const res = await fetchDailyPuzzle();
  if (!res.ok) return;
  const puzzle = res.data;

  await waitForModels();
  stopLobbyPolling();
  gameMode = 'puzzle';
  onlineGameEnded = false;

  chess = new Chess(puzzle.fen);
  myColor = chess.turn();
  puzzleState = { id: puzzle.id, movesSoFar: [] };
  pendingPuzzleAdvance = null;

  selectedSquare = null;
  clearHighlights(markerMeshes);
  orientCameraForColor(camera, controls, defaultCameraPos, myColor);
  pieceManager.buildFromBoard(chess);
  ui.renderHistory([]);
  ui.setStatus('');
  ui.setTurn(chess.turn());
  syncClocks(null);

  menuScreen.classList.add('hidden');
  uiRoot.classList.remove('hidden');

  opponentInfo.classList.remove('hidden');
  opponentInfo.textContent = puzzleObjectiveText(puzzle);
  resignBtn.classList.add('hidden');
  document.getElementById('difficulty-select').classList.add('hidden');
  document.getElementById('new-game').classList.add('hidden');
  document.getElementById('replay-controls').classList.add('hidden');
  rematchBtn.classList.add('hidden');
  document.getElementById('puzzle-exit').classList.remove('hidden');

  inputLocked = false;
}

async function attemptPuzzleMove(from, to, promotion) {
  if (!puzzleState) return;
  inputLocked = true;

  const uci = from + to + (promotion || '');
  const attempt = [...puzzleState.movesSoFar, uci];
  const res = await submitPuzzleAttempt(puzzleState.id, attempt);

  if (!res.ok || !res.data.correct) {
    ui.setStatus('Not quite — try again.');
    inputLocked = false;
    return;
  }

  puzzleState.movesSoFar = attempt;
  const { done, opponentMove } = res.data;

  pendingPuzzleAdvance = () => {
    if (done) {
      ui.setStatus('Puzzle solved!');
      inputLocked = true;
      return;
    }
    ui.setStatus('Correct — opponent replies…');
    setTimeout(() => {
      puzzleState.movesSoFar = [...puzzleState.movesSoFar, opponentMove];
      playMove({
        from: opponentMove.slice(0, 2),
        to: opponentMove.slice(2, 4),
        promotion: opponentMove.length > 4 ? opponentMove[4] : undefined,
      });
    }, 500);
  };

  playMove({ from, to, promotion });
}

document.getElementById('menu-play-puzzle').addEventListener('click', () => {
  startPuzzle();
});

document.getElementById('puzzle-exit').addEventListener('click', () => {
  puzzleState = null;
  pendingPuzzleAdvance = null;
  document.getElementById('puzzle-exit').classList.add('hidden');
  uiRoot.classList.add('hidden');
  menuScreen.classList.remove('hidden');
  showMenuView(menuHome);
});

document.getElementById('menu-back').addEventListener('click', () => {
  showMenuView(menuHome);
});

// ── Board environment ──────────────────────────────────────────────
// Chosen once on the menu rather than live-swapped mid-game — see
// scene/themes.js. Changing it reloads the page since the scene, board,
// and lighting are all built once from the saved theme at module load.

const themeSelect = document.getElementById('menu-theme');
THEMES.forEach((t) => {
  const opt = document.createElement('option');
  opt.value = t.id;
  opt.textContent = t.name;
  themeSelect.appendChild(opt);
});
themeSelect.value = activeTheme.id;
themeSelect.addEventListener('change', () => {
  setTheme(themeSelect.value);
  window.location.reload();
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

  // The server is authoritative on how every game ends (checkmate,
  // stalemate, draw, resignation, or timeout) and on any rating change —
  // this one event covers all of them instead of several overlapping ones.
  // For local move-based endings the client's own chess.js detection
  // already shows an immediate status; this confirms it and appends the
  // rating change once it's computed server-side.
  socket.on('game-over', ({ result, winner, ratings }) => {
    if (gameMode !== 'spectator') {
      const iWon = winner === myColor;
      let text;
      switch (result) {
        case 'timeout': text = iWon ? 'Opponent ran out of time — you win.' : 'You ran out of time — you lose.'; break;
        case 'resignation': text = iWon ? 'Your opponent resigned — you win.' : 'You resigned.'; break;
        case 'abandonment': text = iWon ? 'Your opponent left the game — you win.' : 'You left the game.'; break;
        case 'checkmate': text = `Checkmate — ${iWon ? 'you win.' : 'you lose.'}`; break;
        case 'stalemate': text = 'Stalemate — draw.'; break;
        default: text = 'Draw.';
      }
      if (ratings?.rated) {
        const before = myColor === 'w' ? ratings.whiteRatingBefore : ratings.blackRatingBefore;
        const after = myColor === 'w' ? ratings.whiteRatingAfter : ratings.blackRatingAfter;
        const delta = after - before;
        text += `  Rating: ${before} → ${after} (${delta >= 0 ? '+' : ''}${delta})`;
      }
      ui.setStatus(text);
    }
    onGameEnded();
  });

  // A dropped connection doesn't end the game — the server holds the seat
  // open for a reconnect window. If it lapses, a `game-over` with
  // result: 'abandonment' arrives instead (handled above), not a separate
  // event.
  socket.on('opponent-disconnected', () => {
    if (gameMode === 'online') ui.setStatus('Opponent disconnected — waiting for them to reconnect…');
  });

  socket.on('opponent-reconnected', () => {
    if (gameMode === 'online' && !onlineGameEnded) updateStatusAfterMove();
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
  disconnectSocket();
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
  attemptPuzzleMove,
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
