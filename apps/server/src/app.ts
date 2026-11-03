import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { authHook, registerAuthRoutes, type Auth } from "./auth.js";
import type { Config } from "./config.js";
import { BusyError } from "./password.js";
import type { Collector } from "./scheduler.js";
import { registerStatic } from "./static.js";
import { VERSION } from "./version.js";

export const REFRESH_COOLDOWN_MS = 30_000;

const RANGES: Record<string, number> = {
  "1h": 3_600_000,
  "6h": 21_600_000,
  "12h": 43_200_000,
  "24h": 86_400_000,
};

/** History metrics that always exist (empty `points` until there is data). */
const FIXED_METRICS = new Set([
  "cpu.packageTemp",
  "memory.usedPercent",
  "load.cpuUsagePercent",
  "load.load1",
  "power.packageWatts",
]);

export interface AppOptions {
  config: Config;
  collector: Collector;
  auth: Auth;
  logger?: boolean;
  now?: () => number;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { config, collector, auth } = opts;
  const now = opts.now ?? Date.now;
  // A hop count trusts exactly that many proxies in front of chirp (proxy-addr's
  // `(addr, i) => i < n`); the rest of X-Forwarded-For is client-controlled.
  const hops = config.trustProxy;
  const trustProxy = typeof hops === "number" ? (_addr: string, i: number) => i < hops : hops;
  const app = Fastify({ logger: opts.logger ?? false, trustProxy, bodyLimit: 64 * 1024 });

  if (config.corsOrigins.length) {
    // Bearer-key access only: no credentials (cookies) and never the CSRF header,
    // so a cross-origin page can never act with the dashboard session.
    await app.register(cors, {
      origin: config.corsOrigins,
      allowedHeaders: ["Authorization", "Content-Type"],
      credentials: false,
    });
  }

  // Every error body follows the shared ErrorResponse schema: {"error": <code>}.
  app.setErrorHandler((error: { statusCode?: number }, request, reply) => {
    if (error instanceof BusyError) {
      // Password hashing is saturated (login/bootstrap flood): shed load quickly.
      return reply.code(429).header("retry-after", "1").send({ error: "rate_limited", retryAfter: 1 });
    }
    const status = typeof error.statusCode === "number" && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error(error);
      return reply.code(status).send({ error: "internal_error" });
    }
    const known: Record<number, string> = { 401: "unauthorized", 403: "forbidden", 404: "not_found" };
    const code = known[status] ? status : 400;
    return reply.code(code).send({ error: known[code] ?? "bad_request" });
  });

  app.get("/health", async () => ({ status: "ok" as const, version: VERSION }));

  await app.register(
    async (api) => {
      api.addHook("onRequest", authHook(auth));
      registerAuthRoutes(api, auth, config);

      api.get("/status", async (_req, reply) => {
        reply.header("cache-control", "no-store");
        return collector.getSnapshot();
      });

      api.get<{ Params: { id: string } }>("/disks/:id", async (request, reply) => {
        const detail = collector.getDiskDetail(request.params.id);
        if (!detail) return reply.code(404).send({ error: "not_found" });
        reply.header("cache-control", "no-store");
        return detail;
      });

      api.get<{ Querystring: { metric?: string; range?: string } }>("/history", async (request, reply) => {
        const { metric, range = "24h" } = request.query;
        const rangeMs = RANGES[range];
        if (!metric || rangeMs === undefined) return reply.code(400).send({ error: "bad_request" });
        const diskMatch = /^disk\.([a-z0-9_]+)\.temperature$/.exec(metric);
        const netMatch = /^network\.([a-z0-9_]+)\.(rx|tx)$/.exec(metric);
        const known =
          FIXED_METRICS.has(metric) ||
          (diskMatch !== null && collector.getDiskDetail(diskMatch[1]) !== null) ||
          (netMatch !== null && collector.hasInterface(netMatch[1]));
        if (!known) return reply.code(404).send({ error: "not_found" });
        reply.header("cache-control", "no-store");
        return { metric, points: collector.history.query(metric, rangeMs, now()) };
      });

      let lastRefresh = 0;
      api.post("/refresh", async (_req, reply) => {
        const t = now();
        const wait = lastRefresh + REFRESH_COOLDOWN_MS - t;
        if (lastRefresh !== 0 && wait > 0) {
          const retryAfter = Math.ceil(wait / 1000);
          return reply.code(429).header("retry-after", String(retryAfter)).send({ error: "cooldown", retryAfter });
        }
        lastRefresh = t;
        collector.refresh();
        return reply.code(202).send({ queued: true });
      });
    },
    { prefix: "/api/v1" },
  );

  registerStatic(app, config.webDir);
  return app;
}
