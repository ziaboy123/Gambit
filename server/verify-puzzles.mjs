import { Chess } from 'chess.js';

// Each candidate is either:
//  - { id, theme, rating, game: [SAN from start...], splitAt } — replay `game`
//    from the standard start position; the position after `splitAt` plies is
//    the puzzle FEN, and game.slice(splitAt) is the solution to verify.
//  - { id, theme, rating, fen, solution: [SAN...] } — a hand-built FEN plus
//    the solution SAN sequence to verify directly against it.
const candidates = [
  {
    id: 'scholars-mate',
    theme: 'Mate in 1',
    rating: 400,
    game: ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#'],
    splitAt: 6,
  },
  {
    id: 'fools-mate',
    theme: 'Mate in 1',
    rating: 300,
    game: ['f3', 'e5', 'g4', 'Qh4#'],
    splitAt: 3,
  },
  {
    id: 'legal-trap',
    theme: 'Mate in 2',
    rating: 900,
    game: ['e4', 'e5', 'Nf3', 'd6', 'Bc4', 'Bg4', 'Nc3', 'g6', 'Nxe5', 'Bxd1', 'Bxf7+', 'Ke7', 'Nd5#'],
    splitAt: 10,
  },
  {
    id: 'corner-mate-1',
    theme: 'Mate in 1',
    rating: 200,
    fen: '7k/5K2/8/8/8/8/8/6Q1 w - - 0 1',
    solution: ['Qg7#'],
  },
  {
    id: 'back-rank-mate-1',
    theme: 'Mate in 1',
    rating: 250,
    fen: '6k1/5ppp/8/8/8/8/8/RK6 w - - 0 1',
    solution: ['Ra8#'],
  },
  {
    id: 'corner-mate-2',
    theme: 'Mate in 1',
    rating: 200,
    fen: 'k7/8/2K5/8/8/8/8/1Q6 w - - 0 1',
    solution: ['Qb7#'],
  },
  {
    id: 'back-rank-mate-2',
    theme: 'Mate in 1',
    rating: 250,
    fen: 'k7/8/8/r7/8/8/5PPP/6K1 b - - 0 1',
    solution: ['Ra1#'],
  },
];

let allOk = true;

for (const c of candidates) {
  console.log(`\n=== ${c.id} (${c.theme}, ~${c.rating}) ===`);
  let chess;
  let solutionSan;
  let startFen;

  try {
    if (c.game) {
      chess = new Chess();
      for (const san of c.game) {
        const m = chess.move(san);
        if (!m) throw new Error(`illegal move in game replay: ${san}`);
      }
      // Replay again, stopping at splitAt, to capture the puzzle start FEN.
      const setup = new Chess();
      for (let i = 0; i < c.splitAt; i++) setup.move(c.game[i]);
      startFen = setup.fen();
      solutionSan = c.game.slice(c.splitAt);
      chess = setup;
    } else {
      chess = new Chess(c.fen);
      startFen = c.fen;
      solutionSan = c.solution;
    }
  } catch (err) {
    console.log(`  FAIL (setup): ${err.message}`);
    allOk = false;
    continue;
  }

  console.log(`  start FEN: ${startFen}`);
  console.log(`  solver to move: ${chess.turn() === 'w' ? 'White' : 'Black'}`);

  const uci = [];
  let ok = true;
  for (const san of solutionSan) {
    const m = chess.move(san);
    if (!m) {
      console.log(`  FAIL: illegal move "${san}" at position ${chess.fen()}`);
      ok = false;
      break;
    }
    uci.push(m.from + m.to + (m.promotion || ''));
  }
  if (!ok) { allOk = false; continue; }

  const mate = chess.isCheckmate();
  console.log(`  solution UCI: ${JSON.stringify(uci)}`);
  console.log(`  final position checkmate: ${mate}`);
  if (!mate) {
    console.log(`  FAIL: solution does not end in checkmate (final FEN: ${chess.fen()})`);
    allOk = false;
  } else {
    console.log(`  OK`);
  }
}

console.log(`\n${allOk ? 'ALL PUZZLES VERIFIED OK' : 'SOME PUZZLES FAILED — fix before using'}`);
