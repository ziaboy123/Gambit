// Thin wrapper around the Stockfish WASM engine, run as a Web Worker via
// UCI (the text protocol chess engines speak). The worker script and its
// .wasm binary are static files in public/stockfish/ — see README.md for
// where they came from and how to refresh them.

let worker = null;
let readyPromise = null;

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker('/stockfish/stockfish.js');
  return worker;
}

function waitUntilReady() {
  if (readyPromise) return readyPromise;
  const w = ensureWorker();
  readyPromise = new Promise((resolve) => {
    const handler = (e) => {
      if (e.data === 'readyok') {
        w.removeEventListener('message', handler);
        resolve();
      }
    };
    w.addEventListener('message', handler);
    w.postMessage('uci');
    w.postMessage('isready');
  });
  return readyPromise;
}

// Converts a UCI move like "e7e8q" into chess.js's { from, to, promotion }.
function parseUciMove(uci) {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4] : undefined,
  };
}

// `skillLevel` is Stockfish's own 0-20 dial (not full strength even at 20
// without also raising search depth/time — this keeps "Lord Commander"
// beatable rather than a wall). `moveTimeMs` bounds how long it thinks.
export async function getBestMove(fen, { skillLevel = 12, moveTimeMs = 900 } = {}) {
  await waitUntilReady();
  const w = ensureWorker();

  w.postMessage(`setoption name Skill Level value ${skillLevel}`);
  w.postMessage(`position fen ${fen}`);

  return new Promise((resolve) => {
    const handler = (e) => {
      const line = e.data;
      if (typeof line === 'string' && line.startsWith('bestmove')) {
        w.removeEventListener('message', handler);
        resolve(parseUciMove(line.split(' ')[1]));
      }
    };
    w.addEventListener('message', handler);
    w.postMessage(`go movetime ${moveTimeMs}`);
  });
}

// Full-strength evaluation for post-game analysis — deliberately resets
// Skill Level to max each call so a prior capped-strength game against
// "Lord Commander" can't leave the engine artificially weak for analysis.
// Returns the engine's top move and a score from the side-to-move's own
// perspective (positive = good for whoever is to move in `fen`).
export async function evaluatePosition(fen, { depth = 14 } = {}) {
  await waitUntilReady();
  const w = ensureWorker();

  w.postMessage('setoption name Skill Level value 20');
  w.postMessage(`position fen ${fen}`);

  return new Promise((resolve) => {
    let score = { cp: 0, mate: null };
    const handler = (e) => {
      const line = e.data;
      if (typeof line !== 'string') return;
      if (line.startsWith('info') && line.includes(' score ')) {
        const cpMatch = line.match(/score cp (-?\d+)/);
        const mateMatch = line.match(/score mate (-?\d+)/);
        if (mateMatch) score = { cp: null, mate: parseInt(mateMatch[1], 10) };
        else if (cpMatch) score = { cp: parseInt(cpMatch[1], 10), mate: null };
      }
      if (line.startsWith('bestmove')) {
        w.removeEventListener('message', handler);
        const uci = line.split(' ')[1];
        resolve({ bestMove: uci === '(none)' ? null : parseUciMove(uci), score });
      }
    };
    w.addEventListener('message', handler);
    w.postMessage(`go depth ${depth}`);
  });
}

// Converts a score (cp or forced mate, from the side-to-move's own
// perspective) into a single signed centipawn number from White's
// perspective, so evaluations across a whole game can be compared
// directly regardless of whose turn each position was.
export function scoreToWhiteCp(score, sideToMove) {
  const raw = score.mate !== null
    ? Math.sign(score.mate) * (100000 - Math.abs(score.mate) * 100)
    : score.cp;
  return sideToMove === 'w' ? raw : -raw;
}
