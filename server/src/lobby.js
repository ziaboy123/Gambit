import { randomUUID } from 'crypto';
import { Chess } from 'chess.js';
import { resolveTimeControl } from './timeControls.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — easy to misread

function generateCode(existingCodes) {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (existingCodes.has(code));
  return code;
}

function freshClocks(timeControlKey) {
  const tc = resolveTimeControl(timeControlKey);
  return tc.baseMs == null ? null : { w: tc.baseMs, b: tc.baseMs };
}

function makePlayer(socketId, name, userId) {
  return { socketId, name, userId: userId || null, token: randomUUID(), connected: true };
}

export class LobbyStore {
  constructor() {
    this.lobbies = new Map(); // code -> lobby
    this.socketToLobby = new Map(); // socketId -> code
  }

  create({ hostSocketId, hostName, hostUserId, password, timeControl }) {
    const code = generateCode(this.lobbies);
    const hostColor = Math.random() < 0.5 ? 'w' : 'b';
    const timeControlKey = timeControl || 'untimed';
    const hostPlayer = makePlayer(hostSocketId, hostName, hostUserId);
    const lobby = {
      code,
      password: password || null,
      timeControl: timeControlKey,
      chess: new Chess(),
      status: 'waiting', // waiting -> active -> finished
      players: {
        w: hostColor === 'w' ? hostPlayer : null,
        b: hostColor === 'b' ? hostPlayer : null,
      },
      spectators: new Set(),
      createdAt: Date.now(),
      clocks: freshClocks(timeControlKey),
      lastMoveAt: null,
      flagTimer: null,
      disconnectTimers: { w: null, b: null },
      rematchRequestedBy: null,
    };
    this.lobbies.set(code, lobby);
    this.socketToLobby.set(hostSocketId, code);
    return { lobby, hostColor, token: hostPlayer.token };
  }

  join({ code, socketId, name, userId, password }) {
    const lobby = this.lobbies.get(code);
    if (!lobby) return { error: 'No lobby found with that code.' };
    if (lobby.password && lobby.password !== password) return { error: 'Incorrect password.' };
    if (lobby.players.w && lobby.players.b) return { error: 'That lobby is already full.' };

    const joinColor = lobby.players.w ? 'b' : 'w';
    const player = makePlayer(socketId, name, userId);
    lobby.players[joinColor] = player;
    lobby.status = 'active';
    lobby.lastMoveAt = Date.now();
    this.socketToLobby.set(socketId, code);
    return { lobby, color: joinColor, token: player.token };
  }

  spectate({ code, socketId }) {
    const lobby = this.lobbies.get(code);
    if (!lobby) return { error: 'No lobby found with that code.' };
    lobby.spectators.add(socketId);
    this.socketToLobby.set(socketId, code);
    return { lobby };
  }

  // Reattaches a dropped player to their seat using the token issued at
  // create/join time (socket.id changes every reconnect, so it can't be
  // used as the identity across a refresh or network blip).
  reclaim({ code, token, socketId }) {
    const lobby = this.lobbies.get(code);
    if (!lobby) return { error: 'That game is no longer available.' };
    const color = ['w', 'b'].find((c) => lobby.players[c]?.token === token);
    if (!color) return { error: 'Could not reconnect to that game.' };

    if (lobby.disconnectTimers[color]) {
      clearTimeout(lobby.disconnectTimers[color]);
      lobby.disconnectTimers[color] = null;
    }
    lobby.players[color].socketId = socketId;
    lobby.players[color].connected = true;
    this.socketToLobby.set(socketId, code);
    return { lobby, color };
  }

  // Resets the board for a rematch, swapping who plays which color.
  rematch(lobby) {
    lobby.chess = new Chess();
    lobby.status = 'active';
    lobby.clocks = freshClocks(lobby.timeControl);
    lobby.lastMoveAt = Date.now();
    lobby.rematchRequestedBy = null;
    if (lobby.flagTimer) clearTimeout(lobby.flagTimer);
    lobby.flagTimer = null;
    const [w, b] = [lobby.players.w, lobby.players.b];
    lobby.players.w = b;
    lobby.players.b = w;
  }

  getByCode(code) {
    return this.lobbies.get(code) || null;
  }

  getBySocket(socketId) {
    const code = this.socketToLobby.get(socketId);
    return code ? this.lobbies.get(code) : null;
  }

  colorOf(lobby, socketId) {
    if (lobby.players.w?.socketId === socketId) return 'w';
    if (lobby.players.b?.socketId === socketId) return 'b';
    return null;
  }

  // Lists both open (still recruiting) and in-progress games — the client
  // renders the former as "Join" rows and the latter as "Watch" rows.
  listPublic() {
    return Array.from(this.lobbies.values())
      .filter((l) => l.status !== 'finished')
      .map((l) => ({
        code: l.code,
        hasPassword: !!l.password,
        timeControl: l.timeControl,
        hostName: (l.players.w || l.players.b)?.name || 'Anonymous',
        joinable: !(l.players.w && l.players.b),
        players: { w: l.players.w?.name || null, b: l.players.b?.name || null },
        spectators: l.spectators.size,
      }));
  }

  // A player's socket dropped. Mark their seat as disconnected but leave it
  // reserved — the caller schedules a grace-period timer and, if it isn't
  // cancelled by a reclaim() first, calls finalizeDisconnect() to actually
  // free the seat.
  markDisconnected(socketId) {
    const lobby = this.getBySocket(socketId);
    this.socketToLobby.delete(socketId);
    if (!lobby) return null;

    const color = this.colorOf(lobby, socketId);
    if (color) {
      lobby.players[color].connected = false;
      return { lobby, color, isPlayer: true };
    }
    lobby.spectators.delete(socketId);
    return { lobby, color: null, isPlayer: false };
  }

  finalizeDisconnect(lobby, color) {
    if (lobby.players[color]?.connected) return; // they reclaimed the seat already
    lobby.players[color] = null;
    lobby.disconnectTimers[color] = null;
    if (!lobby.players.w && !lobby.players.b && lobby.spectators.size === 0) {
      if (lobby.flagTimer) clearTimeout(lobby.flagTimer);
      this.lobbies.delete(lobby.code);
    }
  }
}
