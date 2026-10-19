// Every socket.io event goes through this instead of a bare socket.on().
// Whatever the client sends is untrusted, so: a payload that isn't a plain
// object becomes {}, an ack that isn't a function becomes a no-op, and if
// the handler throws (or its promise rejects) we log one line and answer
// the ack with an error. Without this, one bad emit like
// socket.emit('create-lobby', null) is an uncaught exception and Node exits,
// taking every live game with it.
const noop = () => {};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function safeOn(socket, event, handler) {
  socket.on(event, (...args) => {
    // socket.io always puts the ack callback last, so only trust it from there
    const ack = typeof args[args.length - 1] === 'function' ? args.pop() : noop;
    const payload = isPlainObject(args[0]) ? args[0] : {};

    const fail = (err) => {
      console.warn(`[socket] ${event} from ${socket.id} failed: ${err?.message || err}`);
      try { ack({ ok: false, error: 'Something went wrong.' }); } catch { /* client's already gone */ }
    };

    try {
      const result = handler(payload, ack);
      if (result && typeof result.then === 'function') result.then(null, fail);
    } catch (err) {
      fail(err);
    }
  });
}
