import { isIPv6 } from "node:net";

/**
 * Throttling for credential checks (login, current password on a change).
 *
 * Every attempt is recorded with begin() *before* the password is checked
 * (parallel guesses count too) and is refunded when it succeeds or when it
 * was never evaluated (the scrypt gate was full). Three mechanisms:
 *
 * 1. Source backoff (source = IPv4 address or IPv6 /64): after FREE_FAILURES
 *    failures it waits 1 s, 2 s, 4 s, ... up to 15 min. Always applies.
 * 2. Username backoff: the same schedule, capped at 5 s. It only applies to
 *    sources that already failed in the window and have never signed in as
 *    that user. A clean source (no recorded failure) or a source with a
 *    previous successful login is still evaluated, so a distributed attack
 *    on the admin's name cannot keep the admin out.
 * 3. Daily budget per username (default 1000 failures per rolling 24 h,
 *    hourly buckets): once spent, only sources with a previous successful
 *    login for that username may try; everyone else gets 429 until failures
 *    age out. This is what bounds a distributed guesser that keeps using
 *    fresh sources. Recovery: wait, restart the service (all of this is in
 *    memory) or `cli.js admin reset-password` (a credential change resets
 *    the username's state).
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
  const addr = ip.replace(/%.*$/, "").toLowerCase();
  if (!isIPv6(addr)) return addr;
  let h: string[] | null;
  let v4: string | null = null;
  if (addr.includes(".")) {
    // Embedded dotted IPv4 (`::ffff:1.2.3.4`): stand in two zero hextets for it.
    const i = addr.lastIndexOf(":");
    v4 = addr.slice(i + 1);
    h = hextets(`${addr.slice(0, i + 1)}0:0`);
  } else {
    h = hextets(addr);
  }
  if (!h) return addr;
  const n = h.map((x) => parseInt(x, 16) || 0);
  if (n.slice(0, 5).every((x) => x === 0) && n[5] === 0xffff) {
    // IPv4-mapped, dotted or hex form (`::ffff:0102:0304`): it is that IPv4 client.
    return v4 ?? `${n[6] >> 8}.${n[6] & 255}.${n[7] >> 8}.${n[7] & 255}`;
  }
  return `${n.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

interface Entry {
  failures: number;
  last: number;
}

/** What begin() recorded, so the attempt can be refunded exactly once. */
export interface Attempt {
  source: string;
  user: string | null;
  at: number;
  refunded: boolean;
}

export type Decision = { ok: true } | { ok: false; waitMs: number; reason: "source" | "user" | "budget" };

export const DEFAULT_DAILY_BUDGET = 1000;
const HOUR = 3_600_000;
const DAY_HOURS = 24;
/** Remembered successful sources per username (most recent kept). */
const MAX_TRUSTED_SOURCES = 32;

export class LoginLimiter {
  private sources = new Map<string, Entry>();
  private users = new Map<string, Entry>();
  /** username -> hour index -> failures in that hour */
  private budget = new Map<string, Map<number, number>>();
  /** username -> sources that signed in successfully (insertion order = recency) */
  private trusted = new Map<string, Set<string>>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly caps: BackoffCaps = DEFAULT_CAPS,
    readonly dailyBudget: number = DEFAULT_DAILY_BUDGET,
  ) {}

  private delay(e: Entry, cap: number): number {
    if (e.failures < FREE_FAILURES) return 0;
    return Math.min(cap, 1000 * 2 ** (e.failures - FREE_FAILURES));
  }

  private live(map: Map<string, Entry>, key: string, t: number): Entry | null {
    const e = map.get(key);
    if (!e) return null;
    if (t - e.last > FORGET_MS) {
      map.delete(key);
      return null;
    }
    return e;
  }

  private wait(e: Entry | null, cap: number, t: number): number {
    return e ? Math.max(0, e.last + this.delay(e, cap) - t) : 0;
  }

  private budgetUsed(user: string, t: number): { used: number; oldestHour: number | null } {
    const b = this.budget.get(user);
    if (!b) return { used: 0, oldestHour: null };
    const hour = Math.floor(t / HOUR);
    let used = 0;
    let oldestHour: number | null = null;
    for (const [h, n] of b) {
      if (h <= hour - DAY_HOURS) {
        b.delete(h);
        continue;
      }
      used += n;
      if (oldestHour === null || h < oldestHour) oldestHour = h;
    }
    if (b.size === 0) this.budget.delete(user);
    return { used, oldestHour };
  }

  /** Failures currently recorded for a source (diagnostics and tests). */
  sourceFailures(ip: string): number {
    return this.live(this.sources, clientKey(ip), this.now())?.failures ?? 0;
  }

  isTrusted(ip: string, user: string): boolean {
    return this.trusted.get(user.toLowerCase())?.has(clientKey(ip)) ?? false;
  }

  /** May this source try this username now? (Nothing is recorded.) */
  check(ip: string, user: string | null): Decision {
    const t = this.now();
    const source = clientKey(ip);
    const sourceEntry = this.live(this.sources, source, t);
    const sourceWait = this.wait(sourceEntry, this.caps.ip, t);
    if (sourceWait > 0) return { ok: false, waitMs: sourceWait, reason: "source" };
    if (!user) return { ok: true };
    const name = user.toLowerCase();
    const trusted = this.trusted.get(name)?.has(source) ?? false;
    if (trusted) return { ok: true };
    const { used, oldestHour } = this.budgetUsed(name, t);
    if (used >= this.dailyBudget && oldestHour !== null) {
      return { ok: false, waitMs: Math.max(1000, (oldestHour + DAY_HOURS) * HOUR - t), reason: "budget" };
    }
    const clean = !sourceEntry || sourceEntry.failures === 0;
    if (clean) return { ok: true };
    const userWait = this.wait(this.live(this.users, name, t), this.caps.user, t);
    return userWait > 0 ? { ok: false, waitMs: userWait, reason: "user" } : { ok: true };
  }

  private bump(map: Map<string, Entry>, key: string, t: number): void {
    if (map.size >= MAX_ENTRIES) this.prune(map, t);
    const e = this.live(map, key, t);
    map.delete(key); // keep Map order = recency for pruning
    map.set(key, e ? { failures: e.failures + 1, last: t } : { failures: 1, last: t });
  }

  /** Record an attempt as a failure before the password is checked. */
  begin(ip: string, user: string | null): Attempt {
    const t = this.now();
    const source = clientKey(ip);
    const name = user?.toLowerCase() ?? null;
    this.bump(this.sources, source, t);
    if (name) {
      this.bump(this.users, name, t);
      if (!this.budget.has(name) && this.budget.size >= MAX_ENTRIES) {
        this.budget.delete(this.budget.keys().next().value as string);
      }
      const b = this.budget.get(name) ?? new Map<number, number>();
      const hour = Math.floor(t / HOUR);
      b.set(hour, (b.get(hour) ?? 0) + 1);
      this.budget.set(name, b);
    }
    return { source, user: name, at: t, refunded: false };
  }

  private unbump(map: Map<string, Entry>, key: string): void {
    const e = map.get(key);
    if (!e) return;
    e.failures -= 1;
    if (e.failures <= 0) map.delete(key);
  }

  /** Undo begin(): the attempt was never evaluated (server busy). */
  refund(a: Attempt): void {
    if (a.refunded) return;
    a.refunded = true;
    this.unbump(this.sources, a.source);
    if (!a.user) return;
    this.unbump(this.users, a.user);
    const b = this.budget.get(a.user);
    const hour = Math.floor(a.at / HOUR);
    const n = b?.get(hour);
    if (b && n) {
      if (n <= 1) b.delete(hour);
      else b.set(hour, n - 1);
    }
  }

  /** The password was right: clear the backoffs and remember the source. */
  succeed(a: Attempt): void {
    this.refund(a);
    this.sources.delete(a.source);
    if (!a.user) return;
    this.users.delete(a.user);
    const set = this.trusted.get(a.user) ?? new Set<string>();
    set.delete(a.source);
    set.add(a.source);
    while (set.size > MAX_TRUSTED_SOURCES) set.delete(set.values().next().value as string);
    this.trusted.set(a.user, set);
  }

  /** Forget everything about a username (its credentials changed). Trusted sources stay. */
  resetUser(user: string): void {
    const name = user.toLowerCase();
    this.users.delete(name);
    this.budget.delete(name);
  }

  private prune(map: Map<string, Entry>, t: number): void {
    for (const [k, e] of map) if (t - e.last > FORGET_MS) map.delete(k);
    // Still full: drop the least recently failing entries.
    while (map.size >= MAX_ENTRIES) map.delete(map.keys().next().value as string);
  }
}
