import { Chess } from 'chess.js';
import { evaluatePosition, scoreToWhiteCp } from './stockfish.js';

// Centipawn loss thresholds, roughly matching the conventions most chess
// sites use for move-quality labels.
const THRESHOLDS = [
  { max: 20, label: 'Best', className: 'best' },
  { max: 50, label: 'Excellent', className: 'excellent' },
  { max: 100, label: 'Good', className: 'good' },
  { max: 200, label: 'Inaccuracy', className: 'inaccuracy' },
  { max: 400, label: 'Mistake', className: 'mistake' },
  { max: Infinity, label: 'Blunder', className: 'blunder' },
];

function classify(lossCp) {
  const loss = Math.max(0, lossCp);
  return THRESHOLDS.find((t) => loss <= t.max);
}

function turnFromFen(fen) {
  return fen.split(' ')[1];
}

// Evaluates every position in the game once (N+1 calls for N moves — each
// "after this move" evaluation doubles as "before the next move"), then
// derives a centipawn-loss and quality label per move by comparing each
// move's actual outcome to what the engine considered achievable there.
export async function analyzeGame(moves, { depth = 14, onProgress } = {}) {
  const chess = new Chess();
  const fens = [chess.fen()];
  for (const san of moves) {
    chess.move(san);
    fens.push(chess.fen());
  }

  const whiteCpByPosition = [];
  for (let i = 0; i < fens.length; i++) {
    const { score } = await evaluatePosition(fens[i], { depth });
    whiteCpByPosition.push(scoreToWhiteCp(score, turnFromFen(fens[i])));
    onProgress?.(i + 1, fens.length);
  }

  return moves.map((san, i) => {
    const moverColor = turnFromFen(fens[i]);
    const beforeWhiteCp = whiteCpByPosition[i];
    const afterWhiteCp = whiteCpByPosition[i + 1];
    const loss = Math.round(moverColor === 'w' ? beforeWhiteCp - afterWhiteCp : afterWhiteCp - beforeWhiteCp);
    const { label, className } = classify(loss);
    return { ply: i + 1, san, color: moverColor, whiteCpAfter: Math.round(afterWhiteCp), loss, label, className };
  });
}
