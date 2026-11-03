import { existsSync, readFileSync } from "node:fs";

/** The service env file of the Proxmox install (systemd EnvironmentFile). */
export const DEFAULT_ENV_FILE = "/etc/chirp/chirp.env";

type Env = Record<string, string | undefined>;

/**
 * Parse simple `KEY=VALUE` lines (the subset systemd EnvironmentFile and
 * docker --env-file share): blank lines and `#` comments are skipped, an
 * optional `export ` prefix is dropped, and a value wrapped in single or double
 * quotes is unwrapped. Unquoted values lose surrounding whitespace and an
 * inline ` #comment`.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, "").trim();
    out[m[1]] = value;
  }
  return out;
}

/**
 * The environment the CLI should use, so `cli.js` sees the same CHIRP_DATA_DIR
 * / CHIRP_API_KEY(_FILE) as the service: `--env-file <path>` wins, then
 * CHIRP_ENV_FILE, then /etc/chirp/chirp.env when it exists. Variables already
 * set in the real environment win over the file. Returns the remaining args.
 */
export function cliEnvironment(
  args: string[],
  env: Env,
  fileExists: (p: string) => boolean = existsSync,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): { env: Env; args: string[]; file: string | null } {
  const rest = [...args];
  let file: string | null = null;
  const i = rest.indexOf("--env-file");
  if (i >= 0) {
    file = rest[i + 1] ?? null;
    if (!file) throw new Error("--env-file needs a path");
    rest.splice(i, 2);
  } else if (env.CHIRP_ENV_FILE?.trim()) {
    file = env.CHIRP_ENV_FILE.trim();
  } else if (fileExists(DEFAULT_ENV_FILE)) {
    file = DEFAULT_ENV_FILE;
  }
  if (!file) return { env, args: rest, file: null };
  const fromFile = parseEnvFile(read(file));
  const merged: Env = { ...fromFile };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) merged[k] = v;
  return { env: merged, args: rest, file };
}
