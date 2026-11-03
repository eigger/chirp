import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { ApiKeyStore } from "./apiKey.js";
import type { Config } from "./config.js";
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

export interface AppOptions {
  config: Config;
  collector: Collector;
  keys: ApiKeyStore;
  logger?: boolean;
  now?: () => number;
}

function bearer(header: string | undefined): string | null {
  // The auth scheme is case-insensitive (RFC 9110 §11.1).
  const m = /^bearer[ \t]+(.+)$/i.exec(header ?? "");
  return m ? m[1].trim() || null : null;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { config, collector, keys } = opts;
  const now = opts.now ?? Date.now;
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: config.trustProxy });

  if (config.corsOrigins.length) {
    await app.register(cors, { origin: config.corsOrigins, allowedHeaders: ["Authorization", "Content-Type"] });
  }

  app.get("/health", async () => ({ status: "ok" as const, version: VERSION }));

  await app.register(
    async (api) => {
      api.addHook("onRequest", async (request, reply) => {
        if (request.method === "OPTIONS") return;
        const token = bearer(request.headers.authorization);
        if (!token || !keys.verify(token)) {
          return reply.code(401).header("www-authenticate", "Bearer").send({ error: "unauthorized" });
        }
      });

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
        const known =
          metric === "cpu.packageTemp" || (diskMatch !== null && collector.getDiskDetail(diskMatch[1]) !== null);
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
