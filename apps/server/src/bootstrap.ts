import { AdminExistsError } from "./admin.js";
import type { Auth } from "./auth.js";
import type { Config } from "./config.js";
import { DEFAULT_ENV_FILE, removeEnvVar } from "./envFile.js";
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
/**
 * A hop count or `true` believes X-Forwarded-For from *any* peer. That is only
 * safe when chirp cannot be reached except through the proxy.
 */
export function trustProxyNotice(config: Pick<Config, "trustProxy" | "host">): Notice | null {
  const t = config.trustProxy;
  if (t !== true && typeof t !== "number") return null;
  const h = config.host.trim();
  const wildcard = h === "" || h === "0.0.0.0" || h === "::" || h === "[::]" || h === "*";
  if (!wildcard) return null;
  return {
    level: "warn",
    msg:
      `CHIRP_TRUST_PROXY=${String(t)} while listening on ${h || "0.0.0.0"}: a client that reaches chirp directly can ` +
      "forge X-Forwarded-For/-Proto (and dodge the per-address login backoff). Set CHIRP_TRUST_PROXY to the proxy's " +
      "IP/CIDR, or bind chirp to 127.0.0.1 / firewall it so only the proxy can reach it.",
  };
}

export async function bootstrapAuth(
  config: Pick<Config, "adminUser" | "adminPassword"> &
    Partial<Pick<Config, "trustProxy" | "host" | "setupToken" | "envFile">>,
  auth: Auth,
): Promise<Notice[]> {
  const out: Notice[] = [];
  if (config.trustProxy !== undefined && config.host !== undefined) {
    const n = trustProxyNotice({ trustProxy: config.trustProxy, host: config.host });
    if (n) out.push(n);
  }
  if (config.adminUser && config.adminPassword) {
    if (!auth.admin.exists()) {
      try {
        await auth.admin.create(config.adminUser, config.adminPassword);
        out.push({ level: "info", msg: `Created admin account "${config.adminUser}" from CHIRP_ADMIN_USER/CHIRP_ADMIN_PASSWORD` });
        if (config.setupToken) {
          config.setupToken = null;
          const file = config.envFile ?? DEFAULT_ENV_FILE;
          const res = removeEnvVar(file, "CHIRP_SETUP_TOKEN");
          if (res.error) {
            const code = (res.error as NodeJS.ErrnoException).code;
            const ro = code === "EROFS" || code === "EACCES" || code === "EPERM";
            out.push({
              level: ro ? "info" : "warn",
              msg: `Could not remove CHIRP_SETUP_TOKEN from ${file}: ${res.error.message}`,
            });
          }
        }
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
    if (config.setupToken) {
      out.push({
        level: "warn",
        msg:
          "No admin account yet: open the dashboard now and create it using the setup token from installation.",
      });
    } else {
      out.push({
        level: "warn",
        msg:
          "No admin account yet: open the dashboard now and create it. Until then anyone who can reach " +
          "this server can create the admin account (or set CHIRP_ADMIN_USER/CHIRP_ADMIN_PASSWORD).",
      });
    }
  }
  return out;
}
