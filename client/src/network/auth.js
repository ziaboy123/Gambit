const API_BASE = import.meta.env.DEV ? 'http://localhost:3004' : window.location.origin;
const TOKEN_KEY = 'gambit_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

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

export async function register(username, password) {
  const res = await request('/api/register', { method: 'POST', body: JSON.stringify({ username, password }) });
  if (res.ok) setToken(res.data.token);
  return res;
}

export async function login(username, password) {
  const res = await request('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  if (res.ok) setToken(res.data.token);
  return res;
}

export async function fetchMe() {
  if (!getToken()) return { ok: false };
  return request('/api/me');
}

export async function fetchLeaderboard(timeControl) {
  return request(`/api/leaderboard?timeControl=${encodeURIComponent(timeControl)}`);
}

export async function fetchHistory(userId) {
  return request(`/api/history/${userId}`);
}

export async function fetchGame(gameId) {
  return request(`/api/game/${gameId}`);
}
