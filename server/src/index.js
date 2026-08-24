import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { LobbyStore } from './lobby.js';
import { resolveTimeControl } from './timeControls.js';

const PORT = process.env.PORT || 3004;

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
    timeControl: lobby.timeControl,
    clocks: lobby.clocks,
    hasPassword: !!lobby.password,
    status: lobby.status,
    players: {
      w: lobby.players.w ? { name: lobby.players.w.name } : null,
      b: lobby.players.b ? { name: lobby.players.b.name } : null,
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
    const { lobby, hostColor } = store.create({
      hostSocketId: socket.id,
      hostName: name || 'Host',
      password,
      timeControl,
    });
    socket.join(lobby.code);
    ack?.({ ok: true, code: lobby.code, color: hostColor, state: publicState(lobby) });
  });

  socket.on('join-lobby', ({ code, name, password } = {}, ack) => {
    const result = store.join({ code: (code || '').toUpperCase(), socketId: socket.id, name: name || 'Guest', password });
    if (result.error) { ack?.({ ok: false, error: result.error }); return; }

    const { lobby, color } = result;
    socket.join(lobby.code);
    scheduleFlagTimer(lobby);
    ack?.({ ok: true, code: lobby.code, color, state: publicState(lobby) });
    socket.to(lobby.code).emit('opponent-joined', { state: publicState(lobby) });
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

  socket.on('disconnect', () => {
    const removed = store.removeSocket(socket.id);
    if (removed) {
      if (removed.lobby.flagTimer) clearTimeout(removed.lobby.flagTimer);
      removed.lobby.flagTimer = null;
      socket.to(removed.code).emit('opponent-disconnected');
    }
  });
});

httpServer.listen(PORT, () => console.log(`Gambit server running on :${PORT}`));
