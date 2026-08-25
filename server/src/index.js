import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { LobbyStore } from './lobby.js';
import { resolveTimeControl } from './timeControls.js';

const PORT = process.env.PORT || 3004;
const RECONNECT_GRACE_MS = 30000;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

app.get('/health', (_req, res) => res.json({ ok: true }));

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
  lobby.flagTimer = setTimeout(() => finishByTimeout(lobby, toMove), ms);
}

function finishByTimeout(lobby, loserColor) {
  if (lobby.status !== 'active') return;
  lobby.status = 'finished';
  lobby.clocks[loserColor] = 0;
  io.to(lobby.code).emit('game-over', { reason: 'timeout', winner: loserColor === 'w' ? 'b' : 'w' });
}

io.on('connection', (socket) => {
  socket.on('create-lobby', ({ name, password, timeControl } = {}, ack) => {
    const { lobby, hostColor, token } = store.create({
      hostSocketId: socket.id,
      hostName: name || 'Host',
      password,
      timeControl,
    });
    socket.join(lobby.code);
    ack?.({ ok: true, code: lobby.code, color: hostColor, token, state: publicState(lobby) });
  });

  socket.on('join-lobby', ({ code, name, password } = {}, ack) => {
    const result = store.join({ code: (code || '').toUpperCase(), socketId: socket.id, name: name || 'Guest', password });
    if (result.error) { ack?.({ ok: false, error: result.error }); return; }

    const { lobby, color, token } = result;
    socket.join(lobby.code);
    scheduleFlagTimer(lobby);
    ack?.({ ok: true, code: lobby.code, color, token, state: publicState(lobby) });
    socket.to(lobby.code).emit('opponent-joined', { state: publicState(lobby) });
  });

  socket.on('spectate-lobby', ({ code } = {}, ack) => {
    const result = store.spectate({ code: (code || '').toUpperCase(), socketId: socket.id });
    if (result.error) { ack?.({ ok: false, error: result.error }); return; }
    socket.join(result.lobby.code);
    ack?.({ ok: true, state: publicState(result.lobby) });
  });

  socket.on('rejoin-lobby', ({ code, token } = {}, ack) => {
    const result = store.reclaim({ code: (code || '').toUpperCase(), token, socketId: socket.id });
    if (result.error) { ack?.({ ok: false, error: result.error }); return; }
    socket.join(result.lobby.code);
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
        finishByTimeout(lobby, color);
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

    if (lobby.chess.isGameOver()) {
      lobby.status = 'finished';
      if (lobby.flagTimer) clearTimeout(lobby.flagTimer);
      lobby.flagTimer = null;
    } else {
      scheduleFlagTimer(lobby);
    }

    ack?.({ ok: true });
    io.to(lobby.code).emit('move-made', {
      move: moveResult,
      fen: lobby.chess.fen(),
      isGameOver: lobby.chess.isGameOver(),
      clocks: lobby.clocks,
    });
  });

  socket.on('resign', (_payload, ack) => {
    const lobby = store.getBySocket(socket.id);
    if (!lobby) { ack?.({ ok: false }); return; }
    const color = store.colorOf(lobby, socket.id);
    lobby.status = 'finished';
    if (lobby.flagTimer) clearTimeout(lobby.flagTimer);
    lobby.flagTimer = null;
    io.to(lobby.code).emit('opponent-resigned', { color });
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
      store.finalizeDisconnect(lobby, color);
      io.to(lobby.code).emit('opponent-left', { color });
    }, RECONNECT_GRACE_MS);
  });
});

httpServer.listen(PORT, () => console.log(`Gambit server running on :${PORT}`));
