import { io } from 'socket.io-client';
import { getToken } from './auth.js';

const SERVER_URL = import.meta.env.DEV ? 'http://localhost:3004' : window.location.origin;

let socket = null;

export function connectSocket() {
  if (socket) return socket;
  socket = io(SERVER_URL, { autoConnect: true, auth: { token: getToken() } });
  return socket;
}

// A manual .disconnect() does not auto-reconnect — leaving the module's
// cached instance in place after one would make every future
// connectSocket() call return that same dead connection. Callers that
// deliberately disconnect (leaving a lobby, logging out) must go through
// this so the next connectSocket() actually opens a fresh one.
export function disconnectSocket() {
  if (socket) socket.disconnect();
  socket = null;
}

export function getSocket() {
  return socket;
}

// Wraps a socket.emit(event, payload, ack) call in a Promise.
export function emitAck(event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, resolve);
  });
}
