import { db } from './db.js';

export function hasSolved(userId, puzzleId) {
  if (!userId) return false;
  const row = db.prepare('SELECT 1 FROM puzzle_solves WHERE user_id = ? AND puzzle_id = ?').get(userId, puzzleId);
  return !!row;
}

export function recordSolve(userId, puzzleId) {
  if (!userId) return;
  db.prepare(`
    INSERT INTO puzzle_solves (user_id, puzzle_id, solved_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, puzzle_id) DO NOTHING
  `).run(userId, puzzleId, Date.now());
}
