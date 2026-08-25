// Every solution is a sequence of UCI moves (solver move, then the
// opponent's scripted reply, alternating) verified offline with chess.js —
// see server/verify-puzzles.mjs, which is not part of the running app.
export const PUZZLES = [
  {
    id: 'scholars-mate', theme: 'Mate in 1', rating: 400,
    fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4',
    solution: ['h5f7'],
  },
  {
    id: 'fools-mate', theme: 'Mate in 1', rating: 300,
    fen: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2',
    solution: ['d8h4'],
  },
  {
    id: 'legal-trap', theme: 'Mate in 2', rating: 900,
    fen: 'rn1qkbnr/ppp2p1p/3p2p1/4N3/2B1P3/2N5/PPPP1PPP/R1BbK2R w KQkq - 0 6',
    solution: ['c4f7', 'e8e7', 'c3d5'],
  },
  {
    id: 'corner-mate-1', theme: 'Mate in 1', rating: 200,
    fen: '7k/5K2/8/8/8/8/8/6Q1 w - - 0 1',
    solution: ['g1g7'],
  },
  {
    id: 'back-rank-mate-1', theme: 'Mate in 1', rating: 250,
    fen: '6k1/5ppp/8/8/8/8/8/RK6 w - - 0 1',
    solution: ['a1a8'],
  },
  {
    id: 'corner-mate-2', theme: 'Mate in 1', rating: 200,
    fen: 'k7/8/2K5/8/8/8/8/1Q6 w - - 0 1',
    solution: ['b1b7'],
  },
  {
    id: 'back-rank-mate-2', theme: 'Mate in 1', rating: 250,
    fen: 'k7/8/8/r7/8/8/5PPP/6K1 b - - 0 1',
    solution: ['a5a1'],
  },
];

// Deterministic by UTC date, so every player sees the same puzzle on the
// same day regardless of timezone quirks in when they load the page.
export function puzzleForDate(dateStr) {
  const days = Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / 86400000);
  const index = ((days % PUZZLES.length) + PUZZLES.length) % PUZZLES.length;
  return PUZZLES[index];
}

export function getPuzzle(id) {
  return PUZZLES.find((p) => p.id === id) || null;
}

export function todayString() {
  return new Date().toISOString().slice(0, 10);
}
