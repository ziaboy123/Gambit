// All three tiers run real Stockfish, at different points on its own 0-20
// skill dial rather than three different hand-rolled search depths — the
// dial is calibrated by Stockfish itself to produce plausible-but-weaker
// play (not just random blunders), which scales far more predictably than
// tuning a local minimax's depth/eval by feel.
import { getBestMove as stockfishBestMove } from './stockfish.js';

export const AI_LEVELS = {
  // Genuinely easy — loses material and misses tactics regularly, but
  // Skill Level 0 combined with a very short think time produces near-random,
  // nonsensical-looking moves rather than "weak but plausible" play. A
  // slightly higher level and a bit more think time keeps it a real beginner
  // rather than a coin flip.
  squire: { label: 'Squire', chooseMove: (chess) => stockfishBestMove(chess.fen(), { skillLevel: 3, moveTimeMs: 500 }) },
  // A bit hard — real tactics, still clearly beatable.
  knight: { label: 'Knight', chooseMove: (chess) => stockfishBestMove(chess.fen(), { skillLevel: 9, moveTimeMs: 900 }) },
  // A genuine challenge — top of the skill dial, longest think time.
  lord: { label: 'Lord Commander', chooseMove: (chess) => stockfishBestMove(chess.fen(), { skillLevel: 20, moveTimeMs: 3500 }) },
};

// Runs the search on a short timeout so the UI can show a "thinking" state
// without blocking. All three levels resolve `chooseMove` as a Promise
// (Stockfish runs in a Web Worker) — this awaits it uniformly.
export function requestAIMove(chess, level, callback) {
  const ai = AI_LEVELS[level] || AI_LEVELS.squire;
  setTimeout(async () => {
    const move = await ai.chooseMove(chess);
    callback(move);
  }, 260);
}
