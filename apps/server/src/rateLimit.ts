import { isIPv6 } from "node:net";

/**
 * Exponential backoff for failed credential checks (login, current password).
 * No hard lockout. Every attempt is counted *before* the password is checked,
 * so parallel guesses are throttled too, and while a key is backing off the
 * password is not evaluated at all (the 429 is no oracle).
 *
 * Two keys per attempt:
 * - the client address (IPv6 grouped by /64, the block one subscriber gets):
 *   after FREE_FAILURES failures it waits 1 s, 2 s, 4 s, ... up to 15 min.
 *   This is what stops guessing from one source.
 * - the username: same schedule but capped at 5 s. A distributed attacker who
 *   keeps failing on the admin's name therefore costs the real admin at most
 *   a few seconds (no lockout), while guessing that name is still bounded to
 *   about one password per 5 s across all sources.
 * Failures are forgotten after FORGET_MS without a new one, or on success.
 */
export const FREE_FAILURES = 5;
export const FORGET_MS = 15 * 60_000;
export const MAX_ENTRIES = 10_000;

export interface BackoffCaps {
  ip: number;
  user: number;
}
export const DEFAULT_CAPS: BackoffCaps = { ip: 15 * 60_000, user: 5_000 };

/** Expand an IPv6 address to its 8 hextets (no zone, no embedded IPv4). */
function hextets(ip: string): string[] | null {
  const [head, tail] = ip.split("::");
  const part = (x: string | undefined) => (x ? x.split(":") : []);
  const h = part(head);
  const t = part(tail);
  if (ip.includes("::")) {
    const fill = 8 - h.length - t.length;
    if (fill < 0) return null;
    return [...h, ...Array<string>(fill).fill("0"), ...t];
  }
  return h.length === 8 ? h : null;
}

/**
 * The rate-limit identity of a client address: IPv4 as is (also when written
 * as `::ffff:a.b.c.d`), IPv6 reduced to its /64 so rotating addresses inside
 * one subscriber's block does not reset the backoff.
 */
export function clientKey(ip: string): string {
  const addr = ip.replace(/%.*$/, "");
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (mapped) return mapped[1];
  if (!isIPv6(addr) || addr.includes(".")) return addr;
  const h = hextets(addr.toLowerCase());
  if (!h) return addr;
  return `${h.slice(0, 4).map((x) => (parseInt(x, 16) || 0).toString(16)).join(":")}::/64`;
}

interface Entry {
  failures: number;
  last: number;
}

export class LoginLimiter {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly caps: BackoffCaps = DEFAULT_CAPS,
  ) {}

  private keys(ip: string, user: string | null): [string, number][] {
    const out: [string, number][] = [[`ip:${clientKey(ip)}`, this.caps.ip]];
    if (user) out.push([`user:${user.toLowerCase()}`, this.caps.user]);
    return out;
  }

  private delay(e: Entry, cap: number): number {
    if (e.failures < FREE_FAILURES) return 0;
    return Math.min(cap, 1000 * 2 ** (e.failures - FREE_FAILURES));
  }

  /** Milliseconds the caller still has to wait (0 = may try now). */
  retryAfterMs(ip: string, user: string | null): number {
    const t = this.now();
    let wait = 0;
    for (const [k, cap] of this.keys(ip, user)) {
      const e = this.entries.get(k);
      if (!e) continue;
      if (t - e.last > FORGET_MS) {
        this.entries.delete(k);
        continue;
      }
      wait = Math.max(wait, e.last + this.delay(e, cap) - t);
    }
    return wait;
  }

  fail(ip: string, user: string | null): void {
    const t = this.now();
    if (this.entries.size >= MAX_ENTRIES) this.prune(t);
    for (const [k] of this.keys(ip, user)) {
      const e = this.entries.get(k);
      if (e && t - e.last <= FORGET_MS) {
        e.failures += 1;
        e.last = t;
        this.entries.delete(k); // keep Map order = recency for pruning
        this.entries.set(k, e);
      } else {
        this.entries.delete(k);
        this.entries.set(k, { failures: 1, last: t });
      }
    }
  }

  succeed(ip: string, user: string | null): void {
    for (const [k] of this.keys(ip, user)) this.entries.delete(k);
  }

  private prune(t: number): void {
    for (const [k, e] of this.entries) if (t - e.last > FORGET_MS) this.entries.delete(k);
    // Still full: drop the least recently failing entries.
    while (this.entries.size >= MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value as string);
  }
}
