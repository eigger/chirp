import { AdminExistsError } from "./admin.js";
import type { Auth } from "./auth.js";
import type { Config } from "./config.js";
import { cliPath } from "./keyNotice.js";

export interface Notice {
  level: "info" | "warn";
  msg: string;
}

/**
 * Start-up account handling:
 * - CHIRP_ADMIN_USER + CHIRP_ADMIN_PASSWORD seed the admin when none exists
 *   (for automated Docker setups; ignored once an admin exists, so they never
 *   overwrite a password changed later).
 * - Otherwise, while no admin exists, the dashboard offers first-run
 *   registration to whoever opens it first. That window is announced loudly.
 * Nothing here logs a password.
 */
export async function bootstrapAuth(config: Pick<Config, "adminUser" | "adminPassword">, auth: Auth): Promise<Notice[]> {
  const out: Notice[] = [];
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
          `Change the password in the dashboard or with: node ${cliPath()} admin reset-password`,
      });
    }
  }
  if (!auth.admin.exists()) {
    out.push({
      level: "warn",
      msg:
        "No admin account yet: open the dashboard now and create it. Until then anyone who can reach " +
        "this server can create the admin account (or set CHIRP_ADMIN_USER/CHIRP_ADMIN_PASSWORD).",
    });
  }
  return out;
}
