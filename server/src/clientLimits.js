import { isIPv4, isIPv6 } from 'net';

// Bits for per-visitor limits, so one client can't eat all the server's
// memory by opening connections or making lobbies in a loop. Everything here
// is plain in-memory maps, fine since Gambit runs as a single process.

// Who a request is "from". In production everything reaches Node through
// nginx on 127.0.0.1, so the socket address is useless there; Cloudflare puts
// the real visitor in CF-Connecting-IP (and nginx makes sure that header
// can't be faked from the LAN). The header only counts when the connection
// itself came from this machine though: anyone reaching Node's port directly
// could write whatever they like in it and dodge every limit, so for them it's
// their actual address. Locally there's no header (and it's all loopback), so
// it falls back to the socket address. Never throws, whatever junk it gets.
export function clientKey(headers, peerAddress) {
  if (isLoopback(peerAddress)) {
    const header = headers?.['cf-connecting-ip'];
    // a duplicated header arrives joined with commas, first one's the real one
    const fromHeader = typeof header === 'string' ? keyFor(header.split(',')[0]) : null;
    if (fromHeader) return fromHeader;
  }
  return keyFor(peerAddress) || 'unknown';
}

// Turns any spelling of an address into { v4: 'a.b.c.d' } or { v6: [8 numbers] },
// or null if it isn't one. "::ffff:1.2.3.4" (or 0:0:0:0:0:ffff:102:304, same
// thing) is just an IPv4 address dressed up as IPv6, so it comes out as v4.
function parseAddress(value) {
  if (typeof value !== 'string') return null;
  const addr = value.trim().split('%')[0]; // drop any zone id like %en0
  if (isIPv4(addr)) return { v4: addr };
  if (!isIPv6(addr)) return null;
  const groups = ipv6Groups(addr);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return { v4: [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.') };
  }
  return { v6: groups };
}

// Expands the "::" shorthand into all 8 groups as numbers. isIPv6() has
// already checked it's well formed by the time this runs.
function ipv6Groups(addr) {
  const [head, tail] = addr.split('::');
  // an embedded IPv4 bit on the end (like ::ffff:1.2.3.4) is two groups' worth
  const parse = (part) => (part ? part.split(':') : []).flatMap((g) => {
    if (!g.includes('.')) return [parseInt(g, 16)];
    const [a, b, c, d] = g.split('.').map(Number);
    return [(a << 8) | b, (c << 8) | d];
  });
  const left = parse(head);
  const right = parse(tail);
  const zeros = tail === undefined ? [] : Array(8 - left.length - right.length).fill(0);
  return [...left, ...zeros, ...right];
}

// nginx and cloudflared sit on the same box, so they always connect from here
function isLoopback(value) {
  const addr = parseAddress(value);
  if (addr?.v4) return addr.v4.startsWith('127.');
  return !!addr && addr.v6.every((g, i) => g === (i === 7 ? 1 : 0)); // ::1
}

// A home line gets a whole /56 of IPv6 addresses (256 /64s, BT and Sky both
// do this), so keying on the full address or even the /64 would let one
// house dodge the limits by switching address. Keying on the /56 treats it
// like one IPv4 address shared by a household.
function keyFor(value) {
  const addr = parseAddress(value);
  if (!addr) return null; // not an address at all, so ignore it
  if (addr.v4) return addr.v4;
  const prefix = addr.v6.slice(0, 4);
  prefix[3] &= 0xff00; // the /56 ends halfway through the 4th group
  return `${prefix.map((g) => g.toString(16)).join(':')}::/56`;
}

// How many connections each client has open right now. A client's entry
// goes away once they're back to zero, so this never holds more than the
// clients actually connected.
export class ConnectionCounter {
  constructor() {
    this.counts = new Map(); // client -> open connections
  }

  count(client) {
    return this.counts.get(client) || 0;
  }

  add(client) {
    this.counts.set(client, this.count(client) + 1);
  }

  remove(client) {
    const left = this.count(client) - 1;
    if (left > 0) this.counts.set(client, left);
    else this.counts.delete(client);
  }
}

// Allows each client `limit` actions per `windowMs`. allows() only checks,
// record() uses one up, so callers only count the actions that actually went
// through. Old windows get swept out as we go and the map never holds more
// than maxKeys clients, so the bookkeeping can't grow forever either.
export class RateLimiter {
  constructor({ limit, windowMs, maxKeys = 10000, now = () => performance.now() }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.now = now;
    this.windows = new Map(); // client -> { count, resetAt }, oldest window first
  }

  allows(client) {
    const w = this.windows.get(client);
    return !w || w.resetAt <= this.now() || w.count < this.limit;
  }

  record(client) {
    const now = this.now();
    this.sweep(now);
    let w = this.windows.get(client);
    if (!w || w.resetAt <= now) {
      this.windows.delete(client); // re-added at the back so the map stays oldest-first
      // full of clients that are all still inside their window, so the one
      // closest to running out gets dropped (it'd be gone within a minute anyway)
      if (this.windows.size >= this.maxKeys) this.windows.delete(this.windows.keys().next().value);
      w = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(client, w);
    }
    w.count++;
  }

  // Every window is the same length and gets added at the back, so the
  // expired ones are always at the front and we can stop at the first live one.
  sweep(now = this.now()) {
    for (const [client, w] of this.windows) {
      if (w.resetAt > now) break;
      this.windows.delete(client);
    }
  }

  get size() {
    return this.windows.size;
  }
}
