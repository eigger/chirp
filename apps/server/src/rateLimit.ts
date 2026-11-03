/**
 * Exponential backoff for failed credential checks (login, setup code, current
 * password). No hard lockout: after FREE_FAILURES failures a key must wait
 * 1 s, 2 s, 4 s, ... before the next attempt is even evaluated, capped per
 * kind. The per-username cap is short so an attacker who keeps failing on the
 * admin's name can delay the real admin by at most that long (no DoS), while
 * the per-IP cap is long enough to make online guessing hopeless. Failures
 * are forgotten after FORGET_MS without a new one, or on success.
 */
export const FREE_FAILURES = 5;
export const FORGET_MS = 15 * 60_000;
export const MAX_ENTRIES = 10_000;

export interface BackoffCaps {
  ip: number;
  user: number;
}
export const DEFAULT_CAPS: BackoffCaps = { ip: 15 * 60_000, user: 60_000 };

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
    const out: [string, number][] = [[`ip:${ip}`, this.caps.ip]];
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
