import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { FastifyInstance } from "fastify";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Serve the dashboard (`/`, `/assets/*`, other root files) with an SPA fallback.
 * Without an index.html only the JSON 404 handler is installed. /api and
 * /health paths always get `{"error":"not_found"}`.
 */
export function registerStatic(app: FastifyInstance, webDir: string): boolean {
  const root = normalize(webDir);
  const indexPath = join(root, "index.html");
  const hasDashboard = existsSync(indexPath);

  const send = (reply: import("fastify").FastifyReply, file: string, immutable: boolean) => {
    const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    reply
      .header("content-type", type)
      .header("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache")
      .send(readFileSync(file));
    return reply;
  };

  app.setNotFoundHandler((request, reply) => {
    let path: string;
    try {
      path = decodeURIComponent(request.url.split("?")[0] ?? "/");
    } catch {
      // Malformed percent-encoding (e.g. "/%E0%A4%A") must not become a 500.
      return reply.code(400).send({ error: "bad_request" });
    }
    if (path.includes("\0")) return reply.code(404).send({ error: "not_found" });
    const isApi = path === "/health" || path.startsWith("/api/");
    if ((request.method !== "GET" && request.method !== "HEAD") || isApi || !hasDashboard) {
      return reply.code(404).send({ error: "not_found" });
    }
    const target = normalize(join(root, path));
    if (target !== root && !target.startsWith(root + sep)) return reply.code(404).send({ error: "not_found" });
    if (path !== "/" && isFile(target)) return send(reply, target, path.startsWith("/assets/"));
    if (path.startsWith("/assets/")) return reply.code(404).send({ error: "not_found" });
    return send(reply, indexPath, false);
  });
  return hasDashboard;
}
