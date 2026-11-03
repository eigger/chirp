import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AdminExistsError } from "./admin.js";
import type { Auth } from "./auth.js";
import type { Config } from "./config.js";

/** Absolute path of the CLI next to this module (dist/cli.js in a release). */
export function cliPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "cli.js");
}

export interface Notice {
  level: "info" | "warn";
  msg: string;
}

/**
 * Start-up account handling, in order:
 * 1. CHIRP_ADMIN_USER + CHIRP_ADMIN_PASSWORD seed the admin when none exists
 *    (ignored once an admin exists: they never overwrite a changed password).
 * 2. Without an admin, a one-time setup code is created and logged; the
 *    dashboard's setup form requires it, so nobody can claim the server without
 *    access to its log, its data directory or its shell.
 * 3. With an admin, a leftover setup code is removed.
 * Nothing here logs a password or an API key.
 */
export async function bootstrapAuth(config: Pick<Config, "adminUser" | "adminPassword">, auth: Auth): Promise<Notice[]> {
  const out: Notice[] = [];
  const cli = cliPath();
  if (config.adminUser && config.adminPassword) {
    if (!auth.admin.exists()) {
      try {
        await auth.admin.create(config.adminUser, config.adminPassword);
        out.push({ level: "info", msg: `Created admin account "${config.adminUser}" from CHIRP_ADMIN_USER/CHIRP_ADMIN_PASSWORD` });
      } catch (err) {
        if (!(err instanceof AdminExistsError)) throw err;
      }
    } else {
      out.push({
        level: "info",
        msg:
          "An admin account already exists; CHIRP_ADMIN_USER/CHIRP_ADMIN_PASSWORD are ignored. " +
          `Change the password in the dashboard or with: node ${cli} admin reset-password`,
      });
    }
  }
  if (auth.admin.exists()) {
    auth.setup.clear();
  } else {
    const code = auth.setup.ensure();
    out.push({
      level: "warn",
      msg:
        `No admin account yet. Open the dashboard and enter the one-time setup code ${code} ` +
        `(show it again with: node ${cli} admin setup-code), or create the account with: node ${cli} admin create`,
    });
  }
  if (!auth.legacy.active && auth.keys.size === 0) {
    out.push({ level: "info", msg: "No API keys yet: sign in to the dashboard and create one under Settings -> API keys" });
  }
  return out;
}
