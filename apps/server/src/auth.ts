import { join } from "node:path";
import {
  ChangePasswordRequest,
  CreateApiKeyRequest,
  CSRF_HEADER,
  LoginRequest,
  SESSION_COOKIE,
  SetupRequest,
  type ApiKeyInfo,
} from "@chirp/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AdminExistsError, AdminStore, WeakPasswordError } from "./admin.js";
import { LegacyApiKey } from "./apiKey.js";
import { ApiKeyStore, TooManyKeysError } from "./apiKeys.js";
import type { Config } from "./config.js";
import { DEFAULT_SCRYPT, passwordProblem, type ScryptParams } from "./password.js";
import { LoginLimiter } from "./rateLimit.js";
import { SESSION_MAX_MS, SessionStore } from "./session.js";
import { SetupCode } from "./setupCode.js";

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
  keys: ApiKeyStore;
  legacy: LegacyApiKey;
  setup: SetupCode;
  limiter: LoginLimiter;
}

export function dataFiles(dataDir: string) {
  return {
    admin: join(dataDir, "admin.json"),
    keys: join(dataDir, "api-keys.json"),
    setupCode: join(dataDir, "setup-code"),
  };
}

export function createAuth(
  config: Pick<Config, "dataDir" | "apiKey" | "apiKeyFile">,
  opts: { now?: () => number; scrypt?: ScryptParams } = {},
): Auth {
  const now = opts.now ?? Date.now;
  const files = dataFiles(config.dataDir);
  return {
    admin: new AdminStore(files.admin, opts.scrypt ?? DEFAULT_SCRYPT, now),
    sessions: new SessionStore(now),
    keys: new ApiKeyStore(files.keys, now),
    legacy: LegacyApiKey.fromConfig(config),
    setup: new SetupCode(files.setupCode),
    limiter: new LoginLimiter(now),
  };
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
 * - `data`: a Bearer API key (dashboard or legacy key) OR the session cookie.
 *   A present Authorization header is decisive: a wrong key is 401 even with a
 *   valid cookie.
 * - `session`: the session cookie only. An Authorization header is refused
 *   with 403, so an API key (e.g. the one in Home Assistant) can never manage
 *   keys or the admin account.
 */
export function authHook(auth: Auth, now: () => number) {
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
      if (key && (auth.keys.verify(key) || auth.legacy.verify(key, new Date(now())))) return;
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

function legacyEntry(auth: Auth): ApiKeyInfo | null {
  const info = auth.legacy.info();
  if (!info) return null;
  return {
    id: "legacy",
    name: info.source === "env" ? "default (CHIRP_API_KEY)" : "default (api-key file)",
    prefix: info.prefix,
    source: info.source,
    revocable: false,
    createdAt: info.createdAt,
    lastUsedAt: info.lastUsedAt,
  };
}

/** `/api/v1/auth/*` and `/api/v1/keys*`. Registered inside the api plugin (after authHook). */
export function registerAuthRoutes(api: FastifyInstance, auth: Auth, config: Pick<Config, "cookieSecure">): void {
  const pub = { config: { auth: "public" as const } };
  const sess = { config: { auth: "session" as const } };

  const startSession = (request: FastifyRequest, reply: FastifyReply) => {
    const username = auth.admin.username();
    if (!username) throw new Error("admin vanished while creating a session");
    setSessionCookie(config, request, reply, auth.sessions.create(username, auth.admin.credentialStamp()));
    return { username };
  };

  api.get("/auth/setup", pub, async () => ({ required: !auth.admin.exists() }));

  api.post("/auth/setup", pub, async (request, reply) => {
    const body = SetupRequest.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, "bad_request");
    if (auth.admin.exists()) return sendError(reply, 409, "conflict");
    const wait = auth.limiter.retryAfterMs(request.ip, null);
    if (wait > 0) return rateLimited(reply, wait);
    // Count the attempt before checking, so parallel guesses are throttled too.
    auth.limiter.fail(request.ip, null);
    if (!auth.setup.matches(body.data.setupCode)) return sendError(reply, 401, "unauthorized");
    auth.limiter.succeed(request.ip, null);
    if (passwordProblem(body.data.password)) return sendError(reply, 400, "weak_password");
    try {
      await auth.admin.create(body.data.username, body.data.password);
    } catch (err) {
      if (err instanceof AdminExistsError) return sendError(reply, 409, "conflict");
      throw err;
    }
    auth.setup.clear();
    request.log.info(`Admin account "${body.data.username}" created with the setup code`);
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
    if (!body.success) return sendError(reply, 400, "bad_request");
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

  api.get("/keys", sess, async () => {
    const legacy = legacyEntry(auth);
    return { keys: [...(legacy ? [legacy] : []), ...auth.keys.list()] };
  });

  api.post("/keys", sess, async (request, reply) => {
    const body = CreateApiKeyRequest.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, "bad_request");
    try {
      const { info, key } = auth.keys.create(body.data.name);
      request.log.info(`API key "${info.name}" (${info.prefix}…) created`);
      return reply.code(201).send({ ...info, key });
    } catch (err) {
      if (err instanceof TooManyKeysError) return sendError(reply, 409, "conflict");
      throw err;
    }
  });

  api.delete<{ Params: { id: string } }>("/keys/:id", sess, async (request, reply) => {
    const { id } = request.params;
    // The legacy key is configuration, not data: remove CHIRP_API_KEY / the api-key file instead.
    if (id === "legacy") return sendError(reply, 409, "conflict");
    if (!auth.keys.revoke(id)) return sendError(reply, 404, "not_found");
    request.log.info(`API key ${id} revoked`);
    return reply.code(204).send();
  });
}
