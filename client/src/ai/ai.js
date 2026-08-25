// Three AI tiers: Squire (random) and Knight (shallow local search) are
// synchronous; Lord Commander runs real Stockfish in a Web Worker, so its
// chooseMove returns a Promise instead of a move directly.

import { getBestMove as stockfishBestMove } from './stockfish.js';

const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

function evaluateBoard(chess) {
  const board = chess.board();
  let score = 0;
  for (const row of board) {
    for (const cell of row) {
      if (!cell) continue;
      const value = PIECE_VALUES[cell.type];
      score += cell.color === 'w' ? value : -value;
    }
  }
  return score;
}

function randomMove(chess) {
  const moves = chess.moves();
  return moves[Math.floor(Math.random() * moves.length)];
}

function negamax(chess, depth, alpha, beta, color) {
  if (depth === 0 || chess.isGameOver()) {
    return color * evaluateBoard(chess);
  }
  const moves = chess.moves();
  let best = -Infinity;
  for (const move of moves) {
    chess.move(move);
    const score = -negamax(chess, depth - 1, -beta, -alpha, -color);
    chess.undo();
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function searchBestMove(chess, depth) {
  const moves = chess.moves();
  const color = chess.turn() === 'w' ? 1 : -1;
  let bestMove = moves[0];
  let bestScore = -Infinity;
  for (const move of moves) {
    chess.move(move);
    const score = -negamax(chess, depth - 1, -Infinity, Infinity, -color);
    chess.undo();
    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }
  }
  return bestMove;
}

export const AI_LEVELS = {
  squire: { label: 'Squire', chooseMove: (chess) => randomMove(chess) },
  knight: { label: 'Knight', chooseMove: (chess) => searchBestMove(chess, 2) },
  // Skill Level 10 of Stockfish's 0-20 dial — meaningfully strong (real
  // engine tactics, not a local heuristic) but still beatable, rather than
  // the wall a full-strength engine would be.
  lord: { label: 'Lord Commander', chooseMove: (chess) => stockfishBestMove(chess.fen(), { skillLevel: 10, moveTimeMs: 900 }) },
};

// Runs the search on a short timeout so the UI can show a "thinking" state
// without blocking — deeper levels can take a noticeable moment. Squire and
// Knight resolve `chooseMove` synchronously; Lord Commander's Stockfish
// worker resolves it as a Promise — awaiting a plain value is a no-op, so
// this handles both without needing to know which.
export function requestAIMove(chess, level, callback) {
  const ai = AI_LEVELS[level] || AI_LEVELS.squire;
  setTimeout(async () => {
    const move = await ai.chooseMove(chess);
    callback(move);
  }, 260);
}
