import { db } from './db.js';
import { hashPassword, verifyPassword } from './auth.js';
import { STARTING_ELO, computeNewRating } from './elo.js';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

// Every account was made through registerUser, so anything else can't be one
export function looksLikeUsername(name) {
  return typeof name === 'string' && USERNAME_RE.test(name);
}

// The body is whatever JSON the client sent, so both have to actually be
// strings first (an object for a name used to make sqlite throw, and an array
// for a password blew up the hash).
export async function registerUser(username, password) {
  if (!looksLikeUsername(username)) {
    return { error: 'Username must be 3-20 characters, letters/numbers/underscore only.' };
  }
  if (typeof password !== 'string' || password.length < 6) {
    return { error: 'Password must be at least 6 characters.' };
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return { error: 'That username is already taken.' };

  const passwordHash = await hashPassword(password);
  try {
    const result = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
      .run(username, passwordHash, Date.now());
    return { id: Number(result.lastInsertRowid), username };
  } catch (err) {
    // someone else grabbed the same name while this one was hashing
    if (/UNIQUE constraint failed/.test(err.message)) return { error: 'That username is already taken.' };
    throw err;
  }
}

export async function authenticateUser(username, password) {
  // no account has a name like that, so don't bother the database with it
  if (!looksLikeUsername(username) || typeof password !== 'string') {
    return { error: 'Incorrect username or password.' };
  }
  const row = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    return { error: 'Incorrect username or password.' };
  }
  return { id: row.id, username: row.username };
}

export function getUserById(id) {
  const row = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
  return row || null;
}

export function getRatings(userId) {
  const rows = db.prepare('SELECT * FROM ratings WHERE user_id = ?').all(userId);
  const byTimeControl = {};
  for (const row of rows) byTimeControl[row.time_control] = toRatingSummary(row);
  return byTimeControl;
}

function toRatingSummary(row) {
  return { elo: row.elo, gamesPlayed: row.games_played, wins: row.wins, losses: row.losses, draws: row.draws };
}

function getOrCreateRatingRow(userId, timeControl) {
  let row = db.prepare('SELECT * FROM ratings WHERE user_id = ? AND time_control = ?').get(userId, timeControl);
  if (!row) {
    db.prepare('INSERT INTO ratings (user_id, time_control, elo) VALUES (?, ?, ?)').run(userId, timeControl, STARTING_ELO);
    row = db.prepare('SELECT * FROM ratings WHERE user_id = ? AND time_control = ?').get(userId, timeControl);
  }
  return row;
}

function applyRatingResult(userId, timeControl, newElo, outcome) {
  const column = outcome === 'win' ? 'wins' : outcome === 'loss' ? 'losses' : 'draws';
  db.prepare(`UPDATE ratings SET elo = ?, games_played = games_played + 1, ${column} = ${column} + 1 WHERE user_id = ? AND time_control = ?`)
    .run(newElo, userId, timeControl);
}

// `result` is a short machine label ('checkmate' | 'resignation' | 'timeout' | 'stalemate' | 'draw').
// `winner` is 'w' | 'b' | null (null = draw). Only computes rating changes when both sides are
// logged-in users — a guest in the game just means the result is saved unrated.
// All or nothing: if saving fails halfway (database locked, disk full), the
// rating changes get undone too instead of sticking without a game to show for them.
export function recordGame(game) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const record = saveGame(game);
    db.exec('COMMIT');
    return record;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* sqlite already rolled it back */ }
    throw err;
  }
}

function saveGame({ whiteUserId, blackUserId, whiteName, blackName, timeControl, result, winner, moves }) {
  const rated = !!(whiteUserId && blackUserId);
  let whiteBefore = null, blackBefore = null, whiteAfter = null, blackAfter = null;

  if (rated) {
    const whiteRow = getOrCreateRatingRow(whiteUserId, timeControl);
    const blackRow = getOrCreateRatingRow(blackUserId, timeControl);
    whiteBefore = whiteRow.elo;
    blackBefore = blackRow.elo;

    const whiteScore = winner === 'w' ? 1 : winner === 'b' ? 0 : 0.5;
    const blackScore = 1 - whiteScore;
    whiteAfter = computeNewRating(whiteBefore, blackBefore, whiteScore);
    blackAfter = computeNewRating(blackBefore, whiteBefore, blackScore);

    applyRatingResult(whiteUserId, timeControl, whiteAfter, winner === 'w' ? 'win' : winner === 'b' ? 'loss' : 'draw');
    applyRatingResult(blackUserId, timeControl, blackAfter, winner === 'b' ? 'win' : winner === 'w' ? 'loss' : 'draw');
  }

  const insert = db.prepare(`
    INSERT INTO games (white_user_id, black_user_id, white_name, black_name, time_control, result, winner, moves, rated,
      white_rating_before, black_rating_before, white_rating_after, black_rating_after, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    whiteUserId || null, blackUserId || null, whiteName, blackName, timeControl, result, winner,
    JSON.stringify(moves), rated ? 1 : 0,
    whiteBefore, blackBefore, whiteAfter, blackAfter, Date.now()
  );

  return {
    gameId: Number(insert.lastInsertRowid),
    rated,
    whiteRatingBefore: whiteBefore, blackRatingBefore: blackBefore,
    whiteRatingAfter: whiteAfter, blackRatingAfter: blackAfter,
  };
}

export function getLeaderboard(timeControl, limit = 50) {
  return db.prepare(`
    SELECT u.username, r.elo, r.games_played, r.wins, r.losses, r.draws
    FROM ratings r JOIN users u ON u.id = r.user_id
    WHERE r.time_control = ?
    ORDER BY r.elo DESC
    LIMIT ?
  `).all(timeControl, limit).map((row) => ({
    username: row.username, elo: row.elo, gamesPlayed: row.games_played,
    wins: row.wins, losses: row.losses, draws: row.draws,
  }));
}

export function getHistory(userId, limit = 50) {
  return db.prepare(`
    SELECT id, white_name, black_name, white_user_id, black_user_id, time_control, result, winner, rated,
      white_rating_before, black_rating_before, white_rating_after, black_rating_after, ended_at
    FROM games
    WHERE white_user_id = ? OR black_user_id = ?
    ORDER BY ended_at DESC
    LIMIT ?
  `).all(userId, userId, limit).map((row) => {
    const isWhite = row.white_user_id === userId;
    const ratingBefore = isWhite ? row.white_rating_before : row.black_rating_before;
    const ratingAfter = isWhite ? row.white_rating_after : row.black_rating_after;
    return {
      id: row.id,
      opponent: isWhite ? row.black_name : row.white_name,
      color: isWhite ? 'w' : 'b',
      timeControl: row.time_control,
      result: row.result,
      outcome: row.winner === null ? 'draw' : row.winner === (isWhite ? 'w' : 'b') ? 'win' : 'loss',
      rated: !!row.rated,
      ratingBefore, ratingAfter,
      endedAt: row.ended_at,
    };
  });
}

// Guest-vs-guest games (neither seat ever logged in) are deleted after
// this long — see docs/online-safety.md. Rated/account games are kept
// indefinitely since they're tied to a profile the player controls (can
// be renamed or deleted on request — see the same doc).
const GUEST_GAME_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export function pruneGuestGames(now = Date.now()) {
  const cutoff = now - GUEST_GAME_RETENTION_MS;
  const result = db.prepare(
    'DELETE FROM games WHERE white_user_id IS NULL AND black_user_id IS NULL AND ended_at < ?'
  ).run(cutoff);
  return result.changes;
}

export function getGame(gameId) {
  const row = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  if (!row) return null;
  return {
    id: row.id,
    whiteName: row.white_name,
    blackName: row.black_name,
    timeControl: row.time_control,
    result: row.result,
    winner: row.winner,
    moves: JSON.parse(row.moves),
    rated: !!row.rated,
    whiteRatingBefore: row.white_rating_before,
    blackRatingBefore: row.black_rating_before,
    whiteRatingAfter: row.white_rating_after,
    blackRatingAfter: row.black_rating_after,
    endedAt: row.ended_at,
  };
}
