import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { LobbyStore } from './lobby.js';
import { resolveTimeControl } from './timeControls.js';
import { createToken, verifyToken } from './auth.js';
import {
  registerUser, authenticateUser, getUserById, getRatings,
  getLeaderboard, getHistory, getGame, recordGame,
} from './accounts.js';
import { puzzleForDate, getPuzzle, todayString } from './puzzles.js';
import { hasSolved, recordSolve } from './puzzleSolves.js';

const PORT = process.env.PORT || 3004;
const RECONNECT_GRACE_MS = 30000;

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Accounts (REST) ──────────────────────────────────────────────────

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  const result = registerUser(username, password);
  if (result.error) return res.status(400).json(result);
  res.json({ token: createToken({ id: result.id, username: result.username }), user: result });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const result = authenticateUser(username, password);
  if (result.error) return res.status(401).json(result);
  res.json({ token: createToken({ id: result.id, username: result.username }), user: result });
});

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Not authenticated.' });
  req.userId = payload.id;
  next();
}

// Like requireAuth, but for routes guests can also use — attaches req.userId
// when a valid token is present instead of rejecting when it's absent.
function softAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyToken(token);
  if (payload) req.userId = payload.id;
  next();
}

app.get('/api/me', requireAuth, (req, res) => {
  const user = getUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ user, ratings: getRatings(user.id) });
});

app.get('/api/leaderboard', (req, res) => {
  res.json(getLeaderboard(req.query.timeControl || 'blitz'));
});

app.get('/api/history/:userId', (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid user id.' });
  res.json(getHistory(userId));
});

app.get('/api/game/:id', (req, res) => {
  const game = getGame(Number(req.params.id));
  if (!game) return res.status(404).json({ error: 'Game not found.' });
  res.json(game);
});

// ── Daily puzzle (REST) ──────────────────────────────────────────────
// The solution never leaves the server — the client only ever learns the
// next opponent move one ply at a time, after it has submitted a correct
// attempt for the ply before it.

app.get('/api/puzzle/daily', softAuth, (req, res) => {
  const date = todayString();
  const puzzle = puzzleForDate(date);
  res.json({
    id: puzzle.id,
    fen: puzzle.fen,
    theme: puzzle.theme,
    rating: puzzle.rating,
    date,
    solved: hasSolved(req.userId, puzzle.id),
  });
});

app.post('/api/puzzle/attempt', softAuth, (req, res) => {
  const { puzzleId, moves } = req.body || {};
  const puzzle = getPuzzle(puzzleId);
  if (!puzzle) return res.status(404).json({ error: 'Unknown puzzle.' });
  if (!Array.isArray(moves) || moves.length === 0 || moves.length > puzzle.solution.length) {
    return res.status(400).json({ error: 'Invalid attempt.' });
  }

  const correct = moves.every((m, i) => m === puzzle.solution[i]);
  if (!correct) return res.json({ correct: false });

  const done = moves.length === puzzle.solution.length;
  if (done && req.userId) recordSolve(req.userId, puzzle.id);
  res.json({ correct: true, done, opponentMove: done ? null : puzzle.solution[moves.length] });
});

// ── Realtime game ────────────────────────────────────────────────────

const store = new LobbyStore();

function publicState(lobby) {
  return {
    code: lobby.code,
    fen: lobby.chess.fen(),
    history: lobby.chess.history(),
    timeControl: lobby.timeControl,
    clocks: lobby.clocks,
    hasPassword: !!lobby.password,
    status: lobby.status,
    players: {
      w: lobby.players.w ? { name: lobby.players.w.name, connected: lobby.players.w.connected } : null,
      b: lobby.players.b ? { name: lobby.players.b.name, connected: lobby.players.b.connected } : null,
    },
  };
}

function scheduleFlagTimer(lobby) {
  if (lobby.flagTimer) clearTimeout(lobby.flagTimer);
  lobby.flagTimer = null;
  if (!lobby.clocks || lobby.status !== 'active') return;

  const toMove = lobby.chess.turn();
  const ms = Math.max(lobby.clocks[toMove], 0);
  lobby.flagTimer = setTimeout(() => finishGame(lobby, { result: 'timeout', winner: toMove === 'w' ? 'b' : 'w' }), ms);
}

// How the current position ends, if it's over — `winner` is filled in by
// the caller for checkmate (whoever just moved), stays null for draws.
function describeGameOver(chess) {
  if (chess.isCheckmate()) return { result: 'checkmate' };
  if (chess.isStalemate()) return { result: 'stalemate' };
  if (chess.isDraw()) return { result: 'draw' };
  return null;
}

// The single place a game actually ends, regardless of how (checkmate,
// resignation, timeout, draw). Saves the game and — only when both seats
// are logged-in accounts — updates ELO for that time control.
function finishGame(lobby, { result, winner }) {
  if (lobby.status === 'finished') return null; // already recorded — e.g. both sides' grace timers firing
  lobby.status = 'finished';
  if (lobby.flagTimer) clearTimeout(lobby.flagTimer);
  lobby.flagTimer = null;

  const record = recordGame({
    whiteUserId: lobby.players.w?.userId || null,
    blackUserId: lobby.players.b?.userId || null,
    whiteName: lobby.players.w?.name || 'White',
    blackName: lobby.players.b?.name || 'Black',
    timeControl: lobby.timeControl,
    result,
    winner: winner ?? null,
    moves: lobby.chess.history(),
  });

  io.to(lobby.code).emit('game-over', { result, winner: winner ?? null, ratings: record });
  return record;
}

// A socket must belong to exactly one lobby room at a time — otherwise a
// stale event from a lobby it previously left (an abandoned test game, a
// rejoin that failed, a spectated match) can bleed into whatever game it's
// actually in now. socket.io auto-joins a room matching the socket's own
// id; that one is left alone.
function joinLobbyRoom(socket, code) {
  for (const room of socket.rooms) {
    if (room !== socket.id) socket.leave(room);
  }
  socket.join(code);
}

io.on('connection', (socket) => {
  const authPayload = verifyToken(socket.handshake.auth?.token);
  if (authPayload) {
    const user = getUserById(authPayload.id);
    if (user) socket.user = user;
  }

  socket.on('create-lobby', ({ name, password, timeControl } = {}, ack) => {
    const { lobby, hostColor, token } = store.create({
      hostSocketId: socket.id,
      hostName: socket.user?.username || name || 'Host',
      hostUserId: socket.user?.id || null,
      password,
      timeControl,
    });
    joinLobbyRoom(socket, lobby.code);
    ack?.({ ok: true, code: lobby.code, color: hostColor, token, state: publicState(lobby) });
  });

  socket.on('join-lobby', ({ code, name, password } = {}, ack) => {
    const result = store.join({
      code: (code || '').toUpperCase(),
      socketId: socket.id,
      name: socket.user?.username || name || 'Guest',
      userId: socket.user?.id || null,
      password,
    });
    if (result.error) { ack?.({ ok: false, error: result.error }); return; }

    const { lobby, color, token } = result;
    joinLobbyRoom(socket, lobby.code);
    scheduleFlagTimer(lobby);
    ack?.({ ok: true, code: lobby.code, color, token, state: publicState(lobby) });
    socket.to(lobby.code).emit('opponent-joined', { state: publicState(lobby) });
  });

  socket.on('spectate-lobby', ({ code } = {}, ack) => {
    const result = store.spectate({ code: (code || '').toUpperCase(), socketId: socket.id });
    if (result.error) { ack?.({ ok: false, error: result.error }); return; }
    joinLobbyRoom(socket, result.lobby.code);
    ack?.({ ok: true, state: publicState(result.lobby) });
  });

  socket.on('rejoin-lobby', ({ code, token } = {}, ack) => {
    const result = store.reclaim({ code: (code || '').toUpperCase(), token, socketId: socket.id });
    if (result.error) { ack?.({ ok: false, error: result.error }); return; }
    joinLobbyRoom(socket, result.lobby.code);
    ack?.({ ok: true, color: result.color, state: publicState(result.lobby) });
    socket.to(result.lobby.code).emit('opponent-reconnected', { color: result.color });
  });

  socket.on('list-lobbies', (_payload, ack) => {
    ack?.(store.listPublic());
  });

  socket.on('make-move', ({ from, to, promotion } = {}, ack) => {
    const lobby = store.getBySocket(socket.id);
    if (!lobby) { ack?.({ ok: false, error: 'Not in a lobby.' }); return; }

    const color = store.colorOf(lobby, socket.id);
    if (!color) { ack?.({ ok: false, error: 'Spectators cannot move.' }); return; }
    if (lobby.chess.turn() !== color) { ack?.({ ok: false, error: 'Not your turn.' }); return; }

    if (lobby.clocks) {
      const elapsed = Date.now() - lobby.lastMoveAt;
      const remaining = lobby.clocks[color] - elapsed;
      if (remaining <= 0) {
        finishGame(lobby, { result: 'timeout', winner: color === 'w' ? 'b' : 'w' });
        ack?.({ ok: false, error: 'Time expired.' });
        return;
      }
      lobby.clocks[color] = remaining;
    }

    let moveResult;
    try {
      moveResult = lobby.chess.move({ from, to, promotion });
    } catch {
      moveResult = null;
    }
    if (!moveResult) { ack?.({ ok: false, error: 'Illegal move.' }); return; }

    if (lobby.clocks) {
      lobby.clocks[color] += resolveTimeControl(lobby.timeControl).incrementMs;
    }
    lobby.lastMoveAt = Date.now();

    const over = describeGameOver(lobby.chess);
    if (!over) scheduleFlagTimer(lobby); // if it's over, finishGame() below clears the timer instead

    ack?.({ ok: true });
    io.to(lobby.code).emit('move-made', {
      move: moveResult,
      fen: lobby.chess.fen(),
      isGameOver: !!over,
      clocks: lobby.clocks,
    });

    if (over) {
      const winner = over.result === 'checkmate' ? color : null;
      finishGame(lobby, { result: over.result, winner });
    }
  });

  socket.on('resign', (_payload, ack) => {
    const lobby = store.getBySocket(socket.id);
    if (!lobby) { ack?.({ ok: false }); return; }
    const color = store.colorOf(lobby, socket.id);
    if (!color) { ack?.({ ok: false }); return; }
    finishGame(lobby, { result: 'resignation', winner: color === 'w' ? 'b' : 'w' });
    ack?.({ ok: true });
  });

  socket.on('request-rematch', (_payload, ack) => {
    const lobby = store.getBySocket(socket.id);
    if (!lobby) { ack?.({ ok: false }); return; }
    const color = store.colorOf(lobby, socket.id);
    if (!color) { ack?.({ ok: false }); return; }

    if (lobby.rematchRequestedBy && lobby.rematchRequestedBy !== color) {
      store.rematch(lobby);
      scheduleFlagTimer(lobby);
      io.to(lobby.code).emit('rematch-started', { state: publicState(lobby) });
    } else {
      lobby.rematchRequestedBy = color;
      socket.to(lobby.code).emit('rematch-requested', { by: color });
    }
    ack?.({ ok: true });
  });

  // A dropped connection doesn't end the game or pause the clock (that
  // would let a player "pause" by disconnecting when low on time) — it
  // just starts a grace period during which their seat stays reserved for
  // rejoin-lobby to reclaim. If the grace period lapses without a reclaim,
  // the seat is freed and the opponent is told the player left for good.
  socket.on('disconnect', () => {
    const result = store.markDisconnected(socket.id);
    if (!result || !result.isPlayer) return;

    const { lobby, color } = result;
    socket.to(lobby.code).emit('opponent-disconnected', { color });

    lobby.disconnectTimers[color] = setTimeout(() => {
      if (lobby.status === 'active') {
        finishGame(lobby, { result: 'abandonment', winner: color === 'w' ? 'b' : 'w' });
      }
      store.finalizeDisconnect(lobby, color);
    }, RECONNECT_GRACE_MS);
  });
});

httpServer.listen(PORT, () => console.log(`Gambit server running on :${PORT}`));
