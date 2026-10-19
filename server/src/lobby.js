import { randomUUID } from 'crypto';
import { Chess } from 'chess.js';
import { resolveTimeControl } from './timeControls.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — easy to misread
const LIST_MAX = 50; // most lobbies list-lobbies sends back
const MAX_LOBBIES = 1000; // most lobbies that can exist at once, see create()
// Most games one visitor (one network, see clientKey) can have going at once.
// Without it a handful of addresses could sit on all MAX_LOBBIES between them.
// 10 so a house or a uni network sharing one address still has room, and it
// matches the 20-socket limit per network (two players per game).
const MAX_LOBBIES_PER_CLIENT = 10;

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

// whoever's sitting in a lobby (for a waiting one, that's the host)
function hostOf(lobby) {
  return lobby.players.w || lobby.players.b;
}

export class LobbyStore {
  constructor({ maxLobbies = MAX_LOBBIES, maxPerClient = MAX_LOBBIES_PER_CLIENT } = {}) {
    // a Map keeps them in the order they were made, which evictable() relies on
    this.lobbies = new Map(); // code -> lobby
    this.socketToLobby = new Map(); // socketId -> code
    this.maxLobbies = maxLobbies;
    this.maxPerClient = maxPerClient;
  }

  // `hostClient` is who's asking (clientKey), for the per-visitor cap.
  // `evicted` in the result is a lobby that got closed to make room, so the
  // caller can tell whoever was in it.
  create({ hostSocketId, hostClient = null, hostName, hostUserId, password, timeControl }) {
    // let go of wherever this socket was first, so a host remaking their own
    // lobby never counts against them below
    const left = this.release(hostSocketId);
    if (left.error) return left;
    if (this.atClientLimit(hostClient)) {
      return { error: `There are already ${this.maxPerClient} games going from your network. Finish one before starting another.` };
    }
    // Hard cap so no amount of lobby spam can run the server out of memory,
    // even from lots of clients at once. When it's full, the game least likely
    // to be missed makes room (see evictable()), so nobody can lock everyone
    // else out by sitting on lobbies. Joining, watching and rejoining never hit this.
    let evicted = null;
    if (this.lobbies.size >= this.maxLobbies) {
      evicted = this.evictable();
      if (!evicted) return { error: 'The server is busy right now. Try again in a minute.' }; // every one's a game being played
      this.deleteLobby(evicted);
    }

    const code = generateCode(this.lobbies);
    const hostColor = Math.random() < 0.5 ? 'w' : 'b';
    const timeControlKey = timeControl || 'untimed';
    const hostPlayer = makePlayer(hostSocketId, hostName, hostUserId);
    const lobby = {
      code,
      hostClient, // who made it, for openLobbiesFrom()
      password: password || null,
      timeControl: timeControlKey,
      chess: new Chess(),
      // SAN of every move so far. chess.history() replays the whole game to
      // build this, which is slow on a long game, so we keep our own copy.
      moves: [],
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
    return { lobby, hostColor, token: hostPlayer.token, evicted };
  }

  // Games this client made that aren't over: waiting for an opponent or
  // being played. A waiting one counts even while its host is away (it's
  // gone within WAITING_GRACE_MS anyway), otherwise dropping and reclaiming,
  // or getting a mate to join one while the host's away, would sneak extra
  // games past the limit. Finished ones don't count, but a rematch checks
  // again (see rematch()) since that starts them back up.
  openLobbiesFrom(client) {
    let n = 0;
    for (const l of this.lobbies.values()) {
      if (l.hostClient === client && l.status !== 'finished') n++;
    }
    return n;
  }

  atClientLimit(client) {
    return !!client && this.openLobbiesFrom(client) >= this.maxPerClient;
  }

  // Which lobby to close when the server's full, least missed first: a
  // waiting one whose host has gone, then a finished game (the result's
  // already saved, it only costs them a rematch), then the oldest one still
  // waiting for an opponent. A game actually being played is never touched.
  evictable() {
    let finished = null;
    let waiting = null;
    for (const l of this.lobbies.values()) { // oldest first
      if (l.status === 'waiting') {
        if (!hostOf(l)?.connected) return l;
        waiting ??= l;
      } else if (l.status === 'finished') {
        finished ??= l;
      }
    }
    return finished || waiting;
  }

  join({ code, socketId, name, userId, password }) {
    const lobby = this.lobbies.get(code);
    if (!lobby) return { error: 'No lobby found with that code.' };
    if (this.colorOf(lobby, socketId)) return { error: "You're already in that game." };
    if (lobby.password && lobby.password !== password) return { error: 'Incorrect password.' };
    if (lobby.players.w && lobby.players.b) return { error: 'That lobby is already full.' };
    // a finished game can have an empty seat once someone's left, but it's not open for a new player
    if (lobby.status !== 'waiting') return { error: 'That game has already finished.' };
    const left = this.release(socketId);
    if (left.error) return left;

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
    if (this.colorOf(lobby, socketId)) return { error: "You're already playing in that game." };
    if (this.getBySocket(socketId) !== lobby) {
      const left = this.release(socketId);
      if (left.error) return left;
    }
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
    // Seat has to exist first: an empty seat's token is undefined, which
    // would "match" a rejoin that didn't send one.
    const color = ['w', 'b'].find((c) => lobby.players[c] && lobby.players[c].token === token);
    if (!color) return { error: 'Could not reconnect to that game.' };
    // holding both seats would leave one "connected" forever once the socket drops
    const current = this.colorOf(lobby, socketId);
    if (current && current !== color) return { error: "You're already playing in that game." };
    if (this.getBySocket(socketId) === lobby) {
      lobby.spectators.delete(socketId); // they were watching this game, now they're back in their seat
    } else {
      const left = this.release(socketId);
      if (left.error) return left;
    }

    if (lobby.disconnectTimers[color]) {
      clearTimeout(lobby.disconnectTimers[color]);
      lobby.disconnectTimers[color] = null;
    }
    // if the seat's old socket is somehow still around (an old tab), it's not in this game anymore
    const oldSocketId = lobby.players[color].socketId;
    if (oldSocketId !== socketId && this.socketToLobby.get(oldSocketId) === code) this.socketToLobby.delete(oldSocketId);
    lobby.players[color].socketId = socketId;
    lobby.players[color].connected = true;
    this.socketToLobby.set(socketId, code);
    return { lobby, color };
  }

  // Resets the board for a rematch, swapping who plays which color. Counts
  // towards the host's limit like a new game would, otherwise finishing and
  // rematching would let one network keep any number of games going.
  rematch(lobby) {
    if (this.atClientLimit(lobby.hostClient)) {
      // the limit's on the host's network, which might not be whoever pressed accept
      return { error: `The host's network already has ${this.maxPerClient} games going, so a rematch can't start right now.` };
    }
    lobby.chess = new Chess();
    lobby.moves = [];
    lobby.status = 'active';
    lobby.clocks = freshClocks(lobby.timeControl);
    lobby.lastMoveAt = Date.now();
    lobby.rematchRequestedBy = null;
    if (lobby.flagTimer) clearTimeout(lobby.flagTimer);
    lobby.flagTimer = null;
    const [w, b] = [lobby.players.w, lobby.players.b];
    lobby.players.w = b;
    lobby.players.b = w;
    return {};
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
  // Capped at LIST_MAX rows so a flood of lobbies can't make every poll huge
  // (anything past that can still be joined by its code).
  listPublic() {
    const rows = [];
    for (const l of this.lobbies.values()) {
      if (l.status === 'finished') continue;
      // a waiting lobby whose host dropped is only kept so they can refresh back in,
      // there's nobody there to play (and lobby spam would otherwise fill the list)
      if (l.status === 'waiting' && !hostOf(l)?.connected) continue;
      rows.push({
        code: l.code,
        hasPassword: !!l.password,
        timeControl: l.timeControl,
        hostName: hostOf(l)?.name || 'Anonymous',
        joinable: !(l.players.w && l.players.b),
        players: { w: l.players.w?.name || null, b: l.players.b?.name || null },
        spectators: l.spectators.size,
      });
      if (rows.length >= LIST_MAX) break;
    }
    return rows;
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
    this.deleteIfEmpty(lobby); // the last one watching a game nobody's playing in anymore
    return { lobby, color: null, isPlayer: false };
  }

  finalizeDisconnect(lobby, color) {
    if (lobby.players[color]?.connected) return; // they reclaimed the seat already
    lobby.disconnectTimers[color] = null;
    // a lobby still waiting for an opponent is nothing without its host,
    // so it goes even if someone's watching it
    if (lobby.status === 'waiting') { this.deleteLobby(lobby); return; }
    this.freeSeat(lobby, color);
  }

  // One lobby per socket. Before a socket hosts, joins, watches or reclaims a
  // seat somewhere new, it lets go of wherever it was: stops watching, bins
  // the lobby it was hosting if nobody joined yet, or gives up its seat in a
  // finished game. Without this every create-lobby from the same socket left
  // the last lobby in memory forever, so one socket could spam them until
  // Node ran out of memory. Mid-game they have to finish or resign first,
  // otherwise the seat they walked away from would sit there "connected" forever.
  release(socketId) {
    const lobby = this.getBySocket(socketId);
    if (!lobby) {
      this.socketToLobby.delete(socketId);
      return {};
    }
    const color = this.colorOf(lobby, socketId);
    if (color && lobby.status === 'active') return { error: 'Finish or resign your current game first.' };

    this.socketToLobby.delete(socketId);
    if (!color) {
      lobby.spectators.delete(socketId);
      this.deleteIfEmpty(lobby);
    } else if (lobby.status === 'waiting') {
      this.deleteLobby(lobby);
    } else {
      this.freeSeat(lobby, color);
    }
    return {};
  }

  // Empties a seat for good (grace ran out, or they left a finished game).
  freeSeat(lobby, color) {
    lobby.players[color] = null;
    if (lobby.disconnectTimers[color]) clearTimeout(lobby.disconnectTimers[color]);
    lobby.disconnectTimers[color] = null;
    // their rematch offer goes with them, otherwise accepting it would start a game with an empty seat
    if (lobby.rematchRequestedBy === color) lobby.rematchRequestedBy = null;
    this.deleteIfEmpty(lobby);
  }

  deleteIfEmpty(lobby) {
    if (!lobby.players.w && !lobby.players.b && lobby.spectators.size === 0) this.deleteLobby(lobby);
  }

  // Drops the lobby and everything still pointing at it (timers, socket lookups).
  deleteLobby(lobby) {
    if (lobby.flagTimer) clearTimeout(lobby.flagTimer);
    lobby.flagTimer = null;
    for (const c of ['w', 'b']) {
      if (lobby.disconnectTimers[c]) clearTimeout(lobby.disconnectTimers[c]);
      lobby.disconnectTimers[c] = null;
    }
    for (const id of [lobby.players.w?.socketId, lobby.players.b?.socketId, ...lobby.spectators]) {
      if (id && this.socketToLobby.get(id) === lobby.code) this.socketToLobby.delete(id);
    }
    // only if it's still this lobby under that code (codes get reused once freed)
    if (this.lobbies.get(lobby.code) === lobby) this.lobbies.delete(lobby.code);
  }
}
