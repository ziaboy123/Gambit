const API_BASE = import.meta.env.DEV ? 'http://localhost:3004' : window.location.origin;

import { getToken } from './auth.js';

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: data?.error || 'Something went wrong.' };
  return { ok: true, data };
}

export async function fetchDailyPuzzle() {
  return request('/api/puzzle/daily');
}

// `moves` is the full UCI sequence attempted so far, including the move
// just made — the server checks it against the solution as a prefix.
export async function submitPuzzleAttempt(puzzleId, moves) {
  return request('/api/puzzle/attempt', { method: 'POST', body: JSON.stringify({ puzzleId, moves }) });
}
