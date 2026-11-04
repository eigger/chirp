import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig, type Config } from "./config.js";

/**
 * URL a local health probe should hit. A wildcard bind (0.0.0.0, ::) is
 * reachable on loopback; a specific address must be probed on that address.
 */
export function healthUrl(
  config: Pick<Config, "host" | "port"> & Partial<Pick<Config, "tlsCert" | "tlsKey">>,
): string {
  const scheme = config.tlsCert && config.tlsKey ? "https" : "http";
  const host = config.host.trim();
  const wildcard = host === "" || host === "0.0.0.0" || host === "::" || host === "[::]" || host === "*";
  const target = wildcard ? "127.0.0.1" : host.replace(/^\[|\]$/g, "");
  const literal = target.includes(":") ? `[${target}]` : target;
  return `${scheme}://${literal}:${config.port}/health`;
}

/** Container HEALTHCHECK entry point: exit 0 when /health answers 200. */
export async function main(): Promise<number> {
  try {
    const config = loadConfig();
    const url = healthUrl(config);
    if (url.startsWith("https://") && process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return res.ok ? 0 : 1;
  } catch {
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exit(await main());
}
