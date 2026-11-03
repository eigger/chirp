import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";

/** Absolute path of the CLI next to this module (dist/cli.js in a release). */
export function cliPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "cli.js");
}

/**
 * Log line for a freshly generated API key. Logs are often shipped to
 * collectors (journald forwarding, Docker log drivers), so the key itself is
 * only included when the operator opted in with CHIRP_PRINT_KEY=true.
 */
export function newKeyLogMessage(config: Pick<Config, "apiKeyFile" | "printKey">, key: string): string {
  const base =
    `Generated a new API key and stored it in ${config.apiKeyFile} (mode 0600). ` +
    `See it in the dashboard (Settings -> API key) or with: node ${cliPath()} key show`;
  return config.printKey ? `${base} | key: ${key}` : `${base} (set CHIRP_PRINT_KEY=true to print it here)`;
}
