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

export class LobbyStore {
  constructor() {
    this.lobbies = new Map(); // code -> lobby
    this.socketToLobby = new Map(); // socketId -> code
  }

  create({ hostSocketId, hostName, password, timeControl }) {
    const code = generateCode(this.lobbies);
    const hostColor = Math.random() < 0.5 ? 'w' : 'b';
    const timeControlKey = timeControl || 'untimed';
    const lobby = {
      code,
      password: password || null,
      timeControl: timeControlKey,
      chess: new Chess(),
      status: 'waiting', // waiting -> active -> finished
      players: {
        w: hostColor === 'w' ? { socketId: hostSocketId, name: hostName } : null,
        b: hostColor === 'b' ? { socketId: hostSocketId, name: hostName } : null,
      },
      spectators: new Set(),
      createdAt: Date.now(),
      clocks: freshClocks(timeControlKey),
      lastMoveAt: null,
      flagTimer: null,
      rematchRequestedBy: null,
    };
    this.lobbies.set(code, lobby);
    this.socketToLobby.set(hostSocketId, code);
    return { lobby, hostColor };
  }

  join({ code, socketId, name, password }) {
    const lobby = this.lobbies.get(code);
    if (!lobby) return { error: 'No lobby found with that code.' };
    if (lobby.password && lobby.password !== password) return { error: 'Incorrect password.' };
    if (lobby.players.w && lobby.players.b) return { error: 'That lobby is already full.' };

    const joinColor = lobby.players.w ? 'b' : 'w';
    lobby.players[joinColor] = { socketId, name };
    lobby.status = 'active';
    lobby.lastMoveAt = Date.now();
    this.socketToLobby.set(socketId, code);
    return { lobby, color: joinColor };
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

  listPublic() {
    return Array.from(this.lobbies.values())
      .filter((l) => l.status === 'waiting' && !(l.players.w && l.players.b))
      .map((l) => ({
        code: l.code,
        hasPassword: !!l.password,
        timeControl: l.timeControl,
        hostName: (l.players.w || l.players.b)?.name || 'Anonymous',
      }));
  }

  removeSocket(socketId) {
    const code = this.socketToLobby.get(socketId);
    this.socketToLobby.delete(socketId);
    if (!code) return null;
    const lobby = this.lobbies.get(code);
    if (!lobby) return null;

    if (lobby.players.w?.socketId === socketId) lobby.players.w = null;
    if (lobby.players.b?.socketId === socketId) lobby.players.b = null;
    lobby.spectators.delete(socketId);

    // Clean up empty lobbies immediately; leave one-player lobbies for a
    // possible reconnect/rejoin rather than deleting them right away.
    if (!lobby.players.w && !lobby.players.b && lobby.spectators.size === 0) {
      if (lobby.flagTimer) clearTimeout(lobby.flagTimer);
      this.lobbies.delete(code);
      return null;
    }
    return { code, lobby };
  }
}
