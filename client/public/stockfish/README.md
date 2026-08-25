# Stockfish WASM (lite, single-threaded)

`stockfish.js` and `stockfish.wasm` here are the "lite single-threaded"
build from the [`stockfish`](https://www.npmjs.com/package/stockfish) npm
package (v18), renamed from `stockfish-18-lite-single.*` to `stockfish.*`
because the worker script hardcodes that filename when looking for its
WASM binary.

This build was chosen deliberately over the full engine: ~7MB instead of
~113MB, and it runs in any modern browser without the cross-origin
isolation headers the multi-threaded build requires. It's still far
stronger than any casual player.

## Refreshing

```bash
cd client
npm install stockfish@18
cp node_modules/stockfish/bin/stockfish-18-lite-single.js public/stockfish/stockfish.js
cp node_modules/stockfish/bin/stockfish-18-lite-single.wasm public/stockfish/stockfish.wasm
npm uninstall stockfish
```

The npm package isn't a runtime dependency — only these two static files
are used, loaded directly as a Web Worker (see `src/ai/stockfish.js`).
