import { io } from 'socket.io-client';
import { getToken } from './auth.js';

const SERVER_URL = import.meta.env.DEV ? 'http://localhost:3004' : window.location.origin;

let socket = null;

export function connectSocket() {
  if (socket) return socket;
  socket = io(SERVER_URL, { autoConnect: true, auth: { token: getToken() } });
  return socket;
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
