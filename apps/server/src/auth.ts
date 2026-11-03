import { join } from "node:path";
import {
  BootstrapAdminRequest,
  ChangePasswordRequest,
  CSRF_HEADER,
  LoginRequest,
  PASSWORD_MISMATCH,
  SESSION_COOKIE,
} from "@chirp/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodError } from "zod";
import { AdminExistsError, AdminStore, WeakPasswordError } from "./admin.js";
import { ApiKeyStore, EnvKeyError } from "./apiKey.js";
import type { Config } from "./config.js";
import { DEFAULT_SCRYPT, passwordProblem, type ScryptParams } from "./password.js";
import { LoginLimiter } from "./rateLimit.js";
import { SESSION_MAX_MS, SessionStore } from "./session.js";

/** How a route may be reached. Routes without a mode are `data`. */
export type AuthMode = "public" | "data" | "session";

declare module "fastify" {
  interface FastifyContextConfig {
    auth?: AuthMode;
  }
}

/** Everything authentication needs; one instance per server. */
export interface Auth {
  admin: AdminStore;
  sessions: SessionStore;
  key: ApiKeyStore;
  limiter: LoginLimiter;
}

export function adminFile(dataDir: string): string {
  return join(dataDir, "admin.json");
}

export function createAuth(
  config: Pick<Config, "dataDir">,
  key: ApiKeyStore,
  opts: { now?: () => number; scrypt?: ScryptParams } = {},
): Auth {
  const now = opts.now ?? Date.now;
  return {
    admin: new AdminStore(adminFile(config.dataDir), opts.scrypt ?? DEFAULT_SCRYPT, now),
    sessions: new SessionStore(now),
    key,
    limiter: new LoginLimiter(now),
  };
}

/** Runs async jobs one at a time (in this process); the exclusive file create covers other processes. */
function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** `password_mismatch` when the only problem is a differing confirmation, else `bad_request`. */
function bodyError(error: ZodError): "password_mismatch" | "bad_request" {
  return error.issues.length > 0 && error.issues.every((i) => i.message === PASSWORD_MISMATCH)
    ? "password_mismatch"
    : "bad_request";
}

function bearer(header: string | undefined): string | null {
  // The auth scheme is case-insensitive (RFC 9110 §11.1).
  const m = /^bearer[ \t]+(.+)$/i.exec(header ?? "");
  return m ? m[1].trim() || null : null;
}

export function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for cookie-authenticated requests: the session cookie is
 * SameSite=Strict, and every state-changing request must also carry the
 * custom `X-Chirp-Csrf` header. A cross-site page cannot add a custom header
 * without a CORS preflight, and chirp's CORS never allows that header or
 * credentials. (An Origin/Host comparison was not used: reverse proxies often
 * rewrite Host, which would break logins behind them.)
 */
function csrfOk(request: FastifyRequest): boolean {
  return SAFE_METHODS.has(request.method) || request.headers[CSRF_HEADER] === "1";
}

function sendError(reply: FastifyReply, status: number, error: string) {
  return reply.code(status).send({ error });
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).header("www-authenticate", "Bearer").send({ error: "unauthorized" });
}

function rateLimited(reply: FastifyReply, waitMs: number) {
  const retryAfter = Math.max(1, Math.ceil(waitMs / 1000));
  return reply.code(429).header("retry-after", String(retryAfter)).send({ error: "rate_limited", retryAfter });
}

interface SessionCtx {
  user: string;
  token: string;
}
const sessionOf = new WeakMap<FastifyRequest, SessionCtx>();

/**
 * The auth gate for `/api/v1/*` (registered inside the api plugin):
 * - `public`: no credentials; state-changing requests still need the CSRF header.
 * - `data`: the Bearer API key OR the session cookie.
 *   A present Authorization header is decisive: a wrong key is 401 even with a
 *   valid cookie.
 * - `session`: the session cookie only. An Authorization header is refused
 *   with 403, so the API key (e.g. the one in Home Assistant) can never read
 *   or regenerate itself or touch the admin account.
 */
export function authHook(auth: Auth) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method === "OPTIONS") return;
    reply.header("cache-control", "no-store");
    const mode: AuthMode = request.routeOptions.config?.auth ?? "data";
    if (mode === "public") {
      if (!csrfOk(request)) return sendError(reply, 403, "forbidden");
      return;
    }
    const authz = request.headers.authorization;
    if (mode === "data" && authz !== undefined) {
      const key = bearer(authz);
      if (key && auth.key.verify(key)) return;
      return unauthorized(reply);
    }
    if (mode === "session" && authz !== undefined) return sendError(reply, 403, "forbidden");
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    const user = token ? auth.sessions.validate(token, auth.admin.credentialStamp()) : null;
    if (!user || !token) return unauthorized(reply);
    if (!csrfOk(request)) return sendError(reply, 403, "forbidden");
    sessionOf.set(request, { user, token });
  };
}

function cookieSecure(config: Pick<Config, "cookieSecure">, request: FastifyRequest): boolean {
  return config.cookieSecure === "auto" ? request.protocol === "https" : config.cookieSecure;
}

function setSessionCookie(config: Pick<Config, "cookieSecure">, request: FastifyRequest, reply: FastifyReply, token: string) {
  const secure = cookieSecure(config, request) ? "; Secure" : "";
  reply.header(
    "set-cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_MAX_MS / 1000)}${secure}`,
  );
}

function clearSessionCookie(config: Pick<Config, "cookieSecure">, request: FastifyRequest, reply: FastifyReply) {
  const secure = cookieSecure(config, request) ? "; Secure" : "";
  reply.header("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

/** `/api/v1/bootstrap/*`, `/api/v1/auth/*` and `/api/v1/admin/*`. Registered inside the api plugin (after authHook). */
export function registerAuthRoutes(api: FastifyInstance, auth: Auth, config: Pick<Config, "cookieSecure">): void {
  const pub = { config: { auth: "public" as const } };
  const sess = { config: { auth: "session" as const } };

  const startSession = (request: FastifyRequest, reply: FastifyReply) => {
    const username = auth.admin.username();
    if (!username) throw new Error("admin vanished while creating a session");
    setSessionCookie(config, request, reply, auth.sessions.create(username, auth.admin.credentialStamp()));
    return { username };
  };

  const bootstrapLock = serial();

  api.get("/bootstrap/status", pub, async () => ({ needsBootstrap: !auth.admin.exists() }));

  // First-run registration: while no admin exists, the first visitor creates it
  // (like kibble). Requests are serialized here, and the admin file is created
  // exclusively, so two racing requests (or a racing CLI) never both succeed.
  api.post("/bootstrap/admin", pub, async (request, reply) => {
    const body = BootstrapAdminRequest.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, bodyError(body.error));
    if (passwordProblem(body.data.password)) return sendError(reply, 400, "weak_password");
    const created = await bootstrapLock(async () => {
      if (auth.admin.exists()) return false;
      try {
        await auth.admin.create(body.data.username, body.data.password);
        return true;
      } catch (err) {
        if (err instanceof AdminExistsError) return false;
        throw err;
      }
    });
    if (!created) return sendError(reply, 409, "conflict");
    request.log.info(`Admin account "${body.data.username}" created from the dashboard (${request.ip})`);
    return reply.code(201).send(startSession(request, reply));
  });

  api.post("/auth/login", pub, async (request, reply) => {
    const body = LoginRequest.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, "bad_request");
    const { username, password } = body.data;
    const wait = auth.limiter.retryAfterMs(request.ip, username);
    if (wait > 0) return rateLimited(reply, wait);
    auth.limiter.fail(request.ip, username);
    // Same 401 for an unknown user, a wrong password and "no admin yet".
    if (!(await auth.admin.verify(username, password))) return sendError(reply, 401, "unauthorized");
    auth.limiter.succeed(request.ip, username);
    // Never keep two sessions for one browser: the session of the cookie this
    // request came with (if any) ends before the new one is issued.
    auth.sessions.destroy(readCookie(request.headers.cookie, SESSION_COOKIE));
    return startSession(request, reply);
  });

  // Public so a stale cookie can always be cleared; still needs the CSRF header.
  api.post("/auth/logout", pub, async (request, reply) => {
    auth.sessions.destroy(readCookie(request.headers.cookie, SESSION_COOKIE));
    clearSessionCookie(config, request, reply);
    return reply.code(204).send();
  });

  api.get("/auth/me", sess, async (request) => ({ username: sessionOf.get(request)!.user }));

  api.post("/auth/password", sess, async (request, reply) => {
    const body = ChangePasswordRequest.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, bodyError(body.error));
    const user = sessionOf.get(request)!.user;
    const wait = auth.limiter.retryAfterMs(request.ip, user);
    if (wait > 0) return rateLimited(reply, wait);
    auth.limiter.fail(request.ip, user);
    if (!(await auth.admin.verifyPassword(body.data.currentPassword))) {
      return sendError(reply, 400, "invalid_credentials");
    }
    auth.limiter.succeed(request.ip, user);
    try {
      await auth.admin.setPassword(body.data.newPassword);
    } catch (err) {
      if (err instanceof WeakPasswordError) return sendError(reply, 400, "weak_password");
      throw err;
    }
    // Every other session (other browsers, a stolen cookie) ends; this one gets a fresh session.
    auth.sessions.clear();
    startSession(request, reply);
    request.log.info("Admin password changed; all other sessions ended");
    return reply.code(204).send();
  });

  api.get("/admin/api-key", sess, async () => auth.key.current());

  api.post("/admin/api-key/regenerate", sess, async (request, reply) => {
    try {
      const key = auth.key.regenerate();
      request.log.info("API key regenerated from the dashboard; the previous key no longer works");
      return { key };
    } catch (err) {
      // CHIRP_API_KEY is configuration: change it where it is set.
      if (err instanceof EnvKeyError) return sendError(reply, 409, "conflict");
      throw err;
    }
  });
}
