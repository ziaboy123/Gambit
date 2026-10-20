import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { LobbyStore } from './lobby.js';
import { TIME_CONTROLS, resolveTimeControl } from './timeControls.js';
import { createToken, verifyToken } from './auth.js';
import {
  registerUser, authenticateUser, looksLikeUsername, getUserById, getRatings,
  getLeaderboard, getHistory, getGame, recordGame,
} from './accounts.js';
import { puzzleForDate, getPuzzle, todayString } from './puzzles.js';
import { hasSolved, recordSolve } from './puzzleSolves.js';
import { safeOn, safeTimeout } from './safeSocket.js';
import { clientKey, ConnectionCounter, RateLimiter } from './clientLimits.js';

const PORT = process.env.PORT || 3004;
// Only this machine by default: nginx on the same box is the one way in, so
// nothing else on the LAN can talk to Node directly (and skip nginx's
// headers). HOST=0.0.0.0 opens it up again if that's ever needed.
const HOST = process.env.HOST || '127.0.0.1';
const RECONNECT_GRACE_MS = 30000;
// A lobby nobody's joined yet only has to survive its host refreshing the
// page, which takes a few seconds, so it doesn't need the full 30s.
const WAITING_GRACE_MS = 15000;

// Per-visitor limits (see clientLimits.js), so one client looping connect ->
// create-lobby -> disconnect can't fill the server's memory. A household
// shares one address and every open tab is its own socket, so they're generous.
const MAX_SOCKETS_PER_CLIENT = 20;
// Same idea one layer down, for connections that never get as far as
// io.use() below. Higher, so a real visitor always hits the friendly error first.
const MAX_RAW_CONNECTIONS_PER_CLIENT = 40;
const LOBBY_CREATES_PER_MINUTE = 10;
// Login/register guesses. Per visitor (a household shares one, so it's roomy)
// and per account, so spreading guesses over lots of addresses doesn't help.
// A few typos never get near these.
const LOGINS_PER_VISITOR = 20; // per LOGIN_WINDOW_MS
// Wrong guesses at one account from one visitor. Keyed per visitor too, so someone
// hammering a name off the leaderboard only locks themselves out, not the real owner.
const LOGINS_PER_ACCOUNT = 10;
// Backstop for one account across every visitor: high enough that it takes a lot
// of separate addresses to lock a player out, low enough to slow a spread-out guesser.
const LOGINS_PER_ACCOUNT_TOTAL = 100;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const SIGNUPS_PER_VISITOR_PER_HOUR = 10;

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
const rawConnections = new ConnectionCounter();
// Handshakes that got the OK below but haven't reached io.engine's
// 'connection' yet (that's a tick later). Without these, a pile of
// handshakes sent down one connection at once all got past the check
// before the first one was counted.
const pendingHandshakes = new ConnectionCounter();
const io = new Server(httpServer, {
  cors: { origin: '*' },
  // Runs for every brand new connection before socket.io sees it. One that
  // never finishes connecting still sits in memory for ~45s, so a client
  // only gets so many at once.
  allowRequest: (req, callback) => {
    let allowed = true;
    try {
      const client = clientKey(req.headers, req.socket?.remoteAddress);
      allowed = rawConnections.count(client) + pendingHandshakes.count(client) < MAX_RAW_CONNECTIONS_PER_CLIENT;
      if (allowed) {
        pendingHandshakes.add(client);
        setImmediate(() => pendingHandshakes.remove(client)); // counted in rawConnections by then
      }
    } catch (err) {
      console.warn(`[limits] connection check failed: ${err.message}`); // not worth locking everyone out over
    }
    callback(allowed ? null : 'Too many connections.', allowed);
  },
});
io.engine.on('connection', (conn) => {
  // a throw in here would be an unhandled rejection inside engine.io, which takes Node down
  try {
    const client = clientKey(conn.request?.headers, conn.remoteAddress);
    rawConnections.add(client);
    conn.once('close', () => rawConnections.remove(client));
  } catch (err) {
    console.warn(`[limits] couldn't count connection: ${err.message}`);
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Accounts (REST) ──────────────────────────────────────────────────

const loginsByVisitor = new RateLimiter({ limit: LOGINS_PER_VISITOR, windowMs: LOGIN_WINDOW_MS });
const loginsByAccount = new RateLimiter({ limit: LOGINS_PER_ACCOUNT, windowMs: LOGIN_WINDOW_MS }); // key: account + visitor
const loginsByAccountTotal = new RateLimiter({ limit: LOGINS_PER_ACCOUNT_TOTAL, windowMs: LOGIN_WINDOW_MS });
const signupsByVisitor = new RateLimiter({ limit: SIGNUPS_PER_VISITOR_PER_HOUR, windowMs: 60 * 60 * 1000 });

// The client shows `error` right under the form, so say when to come back
function tooMany(res, limiter, key, what) {
  const minutes = Math.max(1, Math.ceil(limiter.msUntilReset(key) / 60000));
  res.set('Retry-After', String(minutes * 60));
  res.status(429).json({ error: `Too many ${what}. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` });
}

// Express 4 doesn't catch a rejected promise from an async route (Node would
// go down on it), so this hands any throw to the error handler at the bottom.
const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch(next);

app.post('/api/register', asyncRoute(async (req, res) => {
  const visitor = clientKey(req.headers, req.socket.remoteAddress);
  if (!signupsByVisitor.allows(visitor)) return tooMany(res, signupsByVisitor, visitor, 'sign-up attempts');
  signupsByVisitor.record(visitor);

  const { username, password } = req.body || {};
  const result = await registerUser(username, password);
  if (result.error) return res.status(400).json(result);
  res.json({ token: createToken({ id: result.id, username: result.username }), user: result });
}));

app.post('/api/login', asyncRoute(async (req, res) => {
  const { username, password } = req.body || {};
  const visitor = clientKey(req.headers, req.socket.remoteAddress);
  // Only real-looking names get their own bucket: junk can't be an account
  // anyway, and a 100 KB "name" kept as a key for 15 minutes adds up fast.
  // Lowercased so flipping the case of a name doesn't get a fresh set of guesses.
  const account = looksLikeUsername(username) ? username.toLowerCase() : null;
  const accountVisitor = account && `${account}|${visitor}`;
  if (!loginsByVisitor.allows(visitor)) return tooMany(res, loginsByVisitor, visitor, 'login attempts');
  if (account && !loginsByAccount.allows(accountVisitor)) return tooMany(res, loginsByAccount, accountVisitor, 'login attempts for this account');
  if (account && !loginsByAccountTotal.allows(account)) return tooMany(res, loginsByAccountTotal, account, 'login attempts for this account');
  // counted before the password check, so a burst all at once can't sneak
  // past while the hashes are still running
  loginsByVisitor.record(visitor);
  if (account) {
    loginsByAccount.record(accountVisitor);
    loginsByAccountTotal.record(account);
  }

  const result = await authenticateUser(username, password);
  if (result.error) return res.status(401).json(result);
  // only wrong guesses use up the allowance, so a busy household never runs out
  loginsByVisitor.forgive(visitor);
  if (account) {
    loginsByAccount.forgive(accountVisitor);
    loginsByAccountTotal.forgive(account);
  }
  res.json({ token: createToken({ id: result.id, username: result.username }), user: result });
}));

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
  // ?timeControl[]=a turns up as an array, so only take a name we actually have
  const timeControl = req.query.timeControl || 'blitz';
  if (!isTimeControl(timeControl)) return res.status(400).json({ error: 'Unknown time control.' });
  res.json(getLeaderboard(timeControl));
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
const lobbyCreates = new RateLimiter({ limit: LOBBY_CREATES_PER_MINUTE, windowMs: 60000 });
const socketsByClient = new ConnectionCounter();

// Socket payloads come straight from the client, so check the fields before
// using them. The length limits match the client's maxlength on the inputs,
// so a real player never hits them.
const NAME_MAX = 20;
const PASSWORD_MAX = 20;
const SQUARE_RE = /^[a-h][1-8]$/;
const PROMOTION_PIECES = ['q', 'r', 'b', 'n'];

// Names and passwords are optional, but if they're there they have to be
// a string that fits.
function isOptionalText(value, max) {
  return value == null || (typeof value === 'string' && value.length <= max);
}

// Lobby codes are 6 characters, so anything that isn't a short string
// can't match a lobby. Returns null for those instead of throwing on .toUpperCase().
function parseCode(code) {
  return typeof code === 'string' && code.length <= 6 ? code.toUpperCase() : null;
}

const isSquare = (value) => typeof value === 'string' && SQUARE_RE.test(value);
const isTimeControl = (value) => typeof value === 'string' && Object.hasOwn(TIME_CONTROLS, value);

function publicState(lobby) {
  return {
    code: lobby.code,
    fen: lobby.chess.fen(),
    history: lobby.moves.slice(), // not chess.history(), see lobby.moves
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
  lobby.flagTimer = safeTimeout(`flag timer for ${lobby.code}`, () => {
    finishGame(lobby, { result: 'timeout', winner: toMove === 'w' ? 'b' : 'w' });
  }, ms);
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

  // Saving can fail (database locked, disk full). The game's over either
  // way, so log it and still tell both players, just without a rating change.
  let record = null;
  try {
    record = recordGame({
      whiteUserId: lobby.players.w?.userId || null,
      blackUserId: lobby.players.b?.userId || null,
      whiteName: lobby.players.w?.name || 'White',
      blackName: lobby.players.b?.name || 'Black',
      timeControl: lobby.timeControl,
      result,
      winner: winner ?? null,
      moves: lobby.moves,
    });
  } catch (err) {
    console.error(`[game] couldn't save game ${lobby.code} (${result}): ${err.message}`);
  }

  io.to(lobby.code).emit('game-over', { result, winner: winner ?? null, ratings: record });
  return record;
}

// A socket must belong to exactly one lobby room at a time — otherwise a
// stale event from a lobby it previously left (an abandoned test game, a
// rejoin that failed, a spectated match) can bleed into whatever game it's
// actually in now. socket.io auto-joins a room matching the socket's own
// id; that one is left alone.
function joinLobbyRoom(socket, code) {
  leaveLobbyRooms(socket);
  socket.join(code);
}

function leaveLobbyRooms(socket) {
  for (const room of socket.rooms) {
    if (room !== socket.id) socket.leave(room);
  }
}

// Tells whoever's still in a lobby the store closed to make room, and takes
// them out of its room, since its code can be handed out again.
function closeLobbyRoom(code) {
  io.to(code).emit('lobby-closed', { reason: 'The server filled up, so this game was closed. Make a new one to keep playing.' });
  io.in(code).socketsLeave(code);
}

// Caps how many sockets (open tabs) one client can have. Counted here rather
// than on 'connection', otherwise a burst of connects sent all at once would
// all get past the check before the first one was counted.
io.use((socket, next) => {
  let refusal = null;
  let uncount = null;
  try {
    const client = clientKey(socket.handshake.headers, socket.handshake.address);
    socket.data.client = client;
    if (socketsByClient.count(client) >= MAX_SOCKETS_PER_CLIENT) {
      refusal = new Error('Too many Gambit tabs are open on your network. Close a few and try again.');
      refusal.data = { reason: 'too-many-connections' };
    } else {
      socketsByClient.add(client);
      let counted = true;
      uncount = () => {
        if (!counted) return;
        counted = false;
        socketsByClient.remove(client);
      };
      socket.once('disconnect', uncount);
    }
  } catch (err) {
    console.warn(`[limits] socket check for ${socket.id} failed: ${err.message}`); // not worth locking everyone out over
  }
  next(refusal);
  // If the client drops before socket.io finishes connecting it, the socket
  // just gets binned without a 'disconnect', so check once it's had its go.
  if (uncount) setImmediate(() => { if (!socket.connected) uncount(); });
});

io.on('connection', (socket) => {
  // set by io.use() above, worked out again only if that somehow didn't run
  const client = socket.data.client ?? clientKey(socket.handshake.headers, socket.handshake.address);

  // A token that doesn't check out just means they play as a guest, it's
  // never worth throwing over.
  try {
    const authPayload = verifyToken(socket.handshake.auth?.token);
    if (authPayload) {
      const user = getUserById(authPayload.id);
      if (user) socket.user = user;
    }
  } catch (err) {
    console.warn(`[socket] auth lookup for ${socket.id} failed: ${err.message}`);
  }

  // Every handler below goes through safeOn (see safeSocket.js): payload is
  // always an object and ack is always a function, even if the client sent junk.
  safeOn(socket, 'create-lobby', ({ name, password, timeControl }, ack) => {
    if (!isOptionalText(name, NAME_MAX)) { ack({ ok: false, error: `Name must be ${NAME_MAX} characters or fewer.` }); return; }
    if (!isOptionalText(password, PASSWORD_MAX)) { ack({ ok: false, error: `Password must be ${PASSWORD_MAX} characters or fewer.` }); return; }
    if (timeControl && !isTimeControl(timeControl)) { ack({ ok: false, error: 'Unknown time control.' }); return; }
    // only lobbies that actually got made count towards the limit (see record() below)
    if (!lobbyCreates.allows(client)) { ack({ ok: false, error: "You're making games too fast. Wait a minute and try again." }); return; }

    const result = store.create({
      hostSocketId: socket.id,
      hostClient: client,
      hostName: socket.user?.username || name || 'Host',
      hostUserId: socket.user?.id || null,
      password,
      timeControl,
    });
    if (result.error) { ack({ ok: false, error: result.error }); return; }
    lobbyCreates.record(client);

    const { lobby, hostColor, token, evicted } = result;
    // the server was full so an old lobby got closed to make room (before
    // joining the new room, in case the new lobby got the same code)
    if (evicted) closeLobbyRoom(evicted.code);
    joinLobbyRoom(socket, lobby.code);
    ack({ ok: true, code: lobby.code, color: hostColor, token, state: publicState(lobby) });
  });

  safeOn(socket, 'join-lobby', ({ code, name, password }, ack) => {
    const lobbyCode = parseCode(code);
    if (!lobbyCode) { ack({ ok: false, error: 'No lobby found with that code.' }); return; }
    if (!isOptionalText(name, NAME_MAX)) { ack({ ok: false, error: `Name must be ${NAME_MAX} characters or fewer.` }); return; }
    if (!isOptionalText(password, PASSWORD_MAX)) { ack({ ok: false, error: 'Incorrect password.' }); return; }

    const result = store.join({
      code: lobbyCode,
      socketId: socket.id,
      name: socket.user?.username || name || 'Guest',
      userId: socket.user?.id || null,
      password,
    });
    if (result.error) { ack({ ok: false, error: result.error }); return; }

    const { lobby, color, token } = result;
    joinLobbyRoom(socket, lobby.code);
    scheduleFlagTimer(lobby);
    ack({ ok: true, code: lobby.code, color, token, state: publicState(lobby) });
    socket.to(lobby.code).emit('opponent-joined', { state: publicState(lobby) });
  });

  safeOn(socket, 'spectate-lobby', ({ code }, ack) => {
    const lobbyCode = parseCode(code);
    if (!lobbyCode) { ack({ ok: false, error: 'No lobby found with that code.' }); return; }

    const result = store.spectate({ code: lobbyCode, socketId: socket.id });
    if (result.error) { ack({ ok: false, error: result.error }); return; }
    joinLobbyRoom(socket, result.lobby.code);
    ack({ ok: true, state: publicState(result.lobby) });
  });

  safeOn(socket, 'rejoin-lobby', ({ code, token }, ack) => {
    const lobbyCode = parseCode(code);
    if (!lobbyCode || typeof token !== 'string') { ack({ ok: false, error: 'Could not reconnect to that game.' }); return; }

    const result = store.reclaim({ code: lobbyCode, token, socketId: socket.id });
    if (result.error) { ack({ ok: false, error: result.error }); return; }
    joinLobbyRoom(socket, result.lobby.code);
    ack({ ok: true, color: result.color, state: publicState(result.lobby) });
    socket.to(result.lobby.code).emit('opponent-reconnected', { color: result.color });
  });

  safeOn(socket, 'list-lobbies', (_payload, ack) => {
    ack(store.listPublic());
  });

  // Cancel on the waiting screen. Bins the lobby straight away instead of
  // leaving it in its refresh grace, where it'd still count towards the
  // network's game limit for a few seconds.
  safeOn(socket, 'leave-lobby', (_payload, ack) => {
    const result = store.release(socket.id);
    if (result.error) { ack({ ok: false, error: result.error }); return; }
    leaveLobbyRooms(socket);
    ack({ ok: true });
  });

  safeOn(socket, 'make-move', ({ from, to, promotion }, ack) => {
    if (!isSquare(from) || !isSquare(to) || (promotion != null && !PROMOTION_PIECES.includes(promotion))) {
      ack({ ok: false, error: 'Illegal move.' });
      return;
    }

    const lobby = store.getBySocket(socket.id);
    if (!lobby) { ack({ ok: false, error: 'Not in a lobby.' }); return; }

    const color = store.colorOf(lobby, socket.id);
    if (!color) { ack({ ok: false, error: 'Spectators cannot move.' }); return; }
    // no moving before the opponent joins or after the game's over
    if (lobby.status !== 'active') { ack({ ok: false, error: 'Game is not in progress.' }); return; }
    if (lobby.chess.turn() !== color) { ack({ ok: false, error: 'Not your turn.' }); return; }

    if (lobby.clocks) {
      const elapsed = Date.now() - lobby.lastMoveAt;
      const remaining = lobby.clocks[color] - elapsed;
      if (remaining <= 0) {
        finishGame(lobby, { result: 'timeout', winner: color === 'w' ? 'b' : 'w' });
        ack({ ok: false, error: 'Time expired.' });
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
    if (!moveResult) { ack({ ok: false, error: 'Illegal move.' }); return; }
    lobby.moves.push(moveResult.san);

    if (lobby.clocks) {
      lobby.clocks[color] += resolveTimeControl(lobby.timeControl).incrementMs;
    }
    lobby.lastMoveAt = Date.now();

    const over = describeGameOver(lobby.chess);
    if (!over) scheduleFlagTimer(lobby); // if it's over, finishGame() below clears the timer instead

    ack({ ok: true });
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

  safeOn(socket, 'resign', (_payload, ack) => {
    const lobby = store.getBySocket(socket.id);
    if (!lobby) { ack({ ok: false }); return; }
    const color = store.colorOf(lobby, socket.id);
    if (!color) { ack({ ok: false }); return; }
    // nothing to resign while waiting for an opponent (or once it's over), and
    // letting it through would save a fake game every time
    if (lobby.status !== 'active') { ack({ ok: false, error: 'Game is not in progress.' }); return; }
    finishGame(lobby, { result: 'resignation', winner: color === 'w' ? 'b' : 'w' });
    ack({ ok: true });
  });

  safeOn(socket, 'request-rematch', (_payload, ack) => {
    const lobby = store.getBySocket(socket.id);
    if (!lobby) { ack({ ok: false }); return; }
    const color = store.colorOf(lobby, socket.id);
    if (!color) { ack({ ok: false }); return; }
    // a rematch mid-game would wipe the board
    if (lobby.status !== 'finished') { ack({ ok: false, error: 'The game is not over yet.' }); return; }
    // Both players have to still be here. If one is in their reconnect grace,
    // the rematch swaps colors but their grace timer still has the old one, so
    // it ends the new game with the player who left as the winner, and their
    // seat never gets freed after that.
    if (!lobby.players.w?.connected || !lobby.players.b?.connected) {
      ack({ ok: false, error: 'Opponent has left.' });
      return;
    }

    if (lobby.rematchRequestedBy && lobby.rematchRequestedBy !== color) {
      const rematch = store.rematch(lobby);
      if (rematch.error) {
        // tell both of them, otherwise whoever asked first sits there waiting forever
        lobby.rematchRequestedBy = null;
        io.to(lobby.code).emit('rematch-refused', { error: rematch.error });
        ack({ ok: false, error: rematch.error });
        return;
      }
      scheduleFlagTimer(lobby);
      io.to(lobby.code).emit('rematch-started', { state: publicState(lobby) });
    } else {
      lobby.rematchRequestedBy = color;
      socket.to(lobby.code).emit('rematch-requested', { by: color });
    }
    ack({ ok: true });
  });

  // A dropped connection doesn't end the game or pause the clock (that
  // would let a player "pause" by disconnecting when low on time) — it
  // just starts a grace period during which their seat stays reserved for
  // rejoin-lobby to reclaim. If the grace period lapses without a reclaim,
  // the seat is freed and the opponent is told the player left for good.
  safeOn(socket, 'disconnect', () => {
    const result = store.markDisconnected(socket.id);
    if (!result || !result.isPlayer) return;

    const { lobby, color } = result;
    socket.to(lobby.code).emit('opponent-disconnected', { color });

    const grace = lobby.status === 'waiting' ? WAITING_GRACE_MS : RECONNECT_GRACE_MS;
    lobby.disconnectTimers[color] = safeTimeout(`reconnect grace for ${lobby.code}`, () => {
      try {
        if (lobby.status === 'active') {
          finishGame(lobby, { result: 'abandonment', winner: color === 'w' ? 'b' : 'w' });
        }
      } finally {
        store.finalizeDisconnect(lobby, color); // the seat still gets freed even if ending the game blew up
      }
    }, grace);
  });
});

// Serves the built client (client/dist) under /gambit and falls back to
// its index.html for any other GET under that path, so the SPA loads on
// a fresh page navigation. Matches the sibling apps' nginx pattern (no
// prefix-stripping — proxy_pass with no URI part forwards the request
// untouched), which is also why /api and /socket.io stay unprefixed at
// root: the client hardcodes window.location.origin with no /gambit path.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.join(__dirname, '../../client/dist');
app.use('/gambit', express.static(clientDist));
app.get(/^\/gambit(\/.*)?$/, (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

// Last stop for anything that went wrong. Express's own error page prints the
// stack with the server's full paths unless NODE_ENV is 'production' (easy to
// forget on the server), so visitors just get a short message and the details
// stay in the log.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err); // too late to send JSON, Express just closes it
  const status = Number.isInteger(err?.status) ? err.status : 500;
  if (status >= 400 && status < 500) {
    // broken JSON, too big a body etc. is the client's problem, not worth logging
    const error = status === 404 ? 'Not found.' : status === 413 ? 'Request too large.' : 'Bad request.';
    return res.status(status).json({ error });
  }
  console.error(`[http] ${req.method} ${req.path} failed: ${err?.message ?? err}`);
  res.status(500).json({ error: 'Server error.' });
});

httpServer.listen(PORT, HOST, () => console.log(`Gambit server running on ${HOST}:${PORT}`));
