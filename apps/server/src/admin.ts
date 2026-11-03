import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { Username } from "@chirp/shared";
import {
  DEFAULT_SCRYPT,
  dummyVerify,
  hashPassword,
  passwordProblem,
  verifyPassword,
  type PasswordHash,
  type PasswordProblem,
  type ScryptParams,
} from "./password.js";
import { createFileExclusive, writeFileAtomic } from "./secureFile.js";

interface AdminFile {
  version: 1;
  username: string;
  password: PasswordHash;
  createdAt: string;
  passwordChangedAt: string;
}

export class AdminExistsError extends Error {
  constructor() {
    super("An admin account already exists");
  }
}
export class InvalidUsernameError extends Error {
  constructor() {
    super("Invalid username: use 1-64 letters, digits, '.', '_', '@' or '-'");
  }
}
export class WeakPasswordError extends Error {
  constructor(readonly problem: PasswordProblem) {
    super(
      problem === "too_short"
        ? "Password is too short"
        : problem === "too_long"
          ? "Password is too long"
          : "Password is too common or easy to guess",
    );
  }
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/**
 * The single admin account in `<dataDir>/admin.json` (0600). Written by both
 * the server (first-run registration, password change, env seed) and the CLI
 * (reset-password), so the server re-reads the file whenever it changes on
 * disk. Creation is an exclusive create, so two concurrent creators (two
 * browsers, two processes) can never both win. `credentialStamp` changes on every password change/reset; sessions
 * remember it and die with it.
 */
export class AdminStore {
  private admin: AdminFile | null = null;
  private stamp = "";

  constructor(
    private readonly file: string,
    private readonly scryptParams: ScryptParams = DEFAULT_SCRYPT,
    private readonly now: () => number = Date.now,
  ) {
    this.refresh(true);
  }

  private statStamp(): string {
    try {
      const s = statSync(this.file);
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch {
      return "missing";
    }
  }

  private refresh(force = false): void {
    const stamp = this.statStamp();
    if (!force && stamp === this.stamp) return;
    this.stamp = stamp;
    if (stamp === "missing") {
      this.admin = null;
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as AdminFile;
      if (typeof parsed?.username === "string" && parsed.password?.algo === "scrypt") this.admin = parsed;
      else this.admin = null;
    } catch {
      this.stamp = ""; // retry on the next call
    }
  }

  exists(): boolean {
    this.refresh();
    return this.admin !== null;
  }

  username(): string | null {
    this.refresh();
    return this.admin?.username ?? null;
  }

  /** Changes whenever the credentials change; empty when there is no admin. */
  credentialStamp(): string {
    this.refresh();
    // The random salt changes on every reset, including resets in the same millisecond.
    return this.admin ? digest(JSON.stringify([this.admin.username, this.admin.password])).toString("hex") : "";
  }

  private async build(username: string, password: string, createdAt?: string): Promise<AdminFile> {
    if (!Username.safeParse(username).success) throw new InvalidUsernameError();
    const problem = passwordProblem(password, username);
    if (problem) throw new WeakPasswordError(problem);
    const at = new Date(this.now()).toISOString();
    return {
      version: 1,
      username,
      password: await hashPassword(password, this.scryptParams),
      createdAt: createdAt ?? at,
      passwordChangedAt: at,
    };
  }

  /** Create the admin. Throws AdminExistsError when one exists (also when another process just created it). */
  async create(username: string, password: string): Promise<void> {
    if (this.exists()) throw new AdminExistsError();
    const admin = await this.build(username, password);
    if (!createFileExclusive(this.file, `${JSON.stringify(admin, null, 2)}\n`)) throw new AdminExistsError();
    this.refresh(true);
  }

  /** Set a new password (and optionally a new username). Every session tied to the old credentials ends. */
  async setPassword(password: string, username?: string): Promise<void> {
    const current = (this.refresh(), this.admin);
    if (!current) throw new Error("No admin account exists");
    const admin = await this.build(username ?? current.username, password, current.createdAt);
    writeFileAtomic(this.file, `${JSON.stringify(admin, null, 2)}\n`);
    this.refresh(true);
  }

  /**
   * Check a username/password pair. Always runs one scrypt (a dummy one when
   * the username is wrong or there is no admin) and compares usernames in
   * constant time, so neither timing nor result reveals which part was wrong.
   */
  async verify(username: string, password: string, priority = false): Promise<boolean> {
    this.refresh();
    const admin = this.admin;
    if (!admin) return dummyVerify(password, this.scryptParams, priority);
    const userOk = timingSafeEqual(digest(username), digest(admin.username));
    const passOk = await verifyPassword(password, admin.password, priority);
    return userOk && passOk;
  }

  /** Check only the password (re-authentication for a password change). */
  async verifyPassword(password: string, priority = false): Promise<boolean> {
    this.refresh();
    if (!this.admin) return dummyVerify(password, this.scryptParams, priority);
    return verifyPassword(password, this.admin.password, priority);
  }
}
