import { createHash, randomBytes } from "node:crypto";

/** Idle timeout: a session ends after this long without a request (sliding). */
export const SESSION_IDLE_MS = 12 * 3_600_000;
/** Absolute lifetime, however active the session is. Also the cookie's Max-Age. */
export const SESSION_MAX_MS = 7 * 24 * 3_600_000;
/** Oldest sessions are dropped beyond this many (bounds memory). */
export const MAX_SESSIONS = 100;

interface Session {
  createdAt: number;
  lastSeen: number;
  /** AdminStore.credentialStamp() at login; a password change/reset changes it. */
  stamp: string;
  username: string;
}

function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Server-side sessions, in memory (a restart logs everyone out). The cookie
 * carries a random 256-bit token; only its sha256 is kept here.
 */
export class SessionStore {
  private sessions = new Map<string, Session>();

  constructor(private readonly now: () => number = Date.now) {}

  create(username: string, stamp: string): string {
    const token = randomBytes(32).toString("base64url");
    const t = this.now();
    this.prune(t);
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string;
      this.sessions.delete(oldest);
    }
    this.sessions.set(digest(token), { createdAt: t, lastSeen: t, stamp, username });
    return token;
  }

  /**
   * The session's username when the token is valid, else null. Touching a
   * session extends its idle timeout. `stamp` is the admin's current
   * credential stamp: a session from before a password change is rejected.
   */
  validate(token: string | null, stamp: string): string | null {
    if (!token) return null;
    const key = digest(token);
    const s = this.sessions.get(key);
    if (!s) return null;
    const t = this.now();
    if (t - s.lastSeen > SESSION_IDLE_MS || t - s.createdAt > SESSION_MAX_MS || !stamp || s.stamp !== stamp) {
      this.sessions.delete(key);
      return null;
    }
    s.lastSeen = t;
    return s.username;
  }

  destroy(token: string | null): void {
    if (token) this.sessions.delete(digest(token));
  }

  /** End every session (password change). */
  clear(): void {
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }

  private prune(t: number): void {
    for (const [k, s] of this.sessions) {
      if (t - s.lastSeen > SESSION_IDLE_MS || t - s.createdAt > SESSION_MAX_MS) this.sessions.delete(k);
    }
  }
}
