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
