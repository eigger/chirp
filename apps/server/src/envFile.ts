import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./secureFile.js";

/** The service env file of the Proxmox install (systemd EnvironmentFile). */
export const DEFAULT_ENV_FILE = "/etc/chirp/chirp.env";

type Env = Record<string, string | undefined>;

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', $: "$", "`": "`" };

/**
 * Parse an env file the way systemd's EnvironmentFile= reads chirp.env:
 * - blank lines and lines starting with `#` or `;` are comments;
 * - `KEY=VALUE` with an optional `export ` prefix and spaces around `=`;
 * - unquoted values are taken literally up to the end of the line (a `#`
 *   inside them is part of the value) with surrounding whitespace removed, and
 *   a trailing backslash continues the value on the next line;
 * - "double quotes" process backslash escapes (`\"`, `\\`, `\n`, `\t`, ...),
 *   'single quotes' are literal; both may span lines, and anything after the
 *   closing quote (such as a `# comment`) is ignored.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let rest = m[2];
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      let value = "";
      let pos = 1;
      let closed = false;
      for (;;) {
        while (pos < rest.length) {
          const c = rest[pos];
          if (c === quote) {
            closed = true;
            break;
          }
          if (quote === '"' && c === "\\" && pos + 1 < rest.length) {
            const next = rest[pos + 1];
            value += ESCAPES[next] ?? `\\${next}`;
            pos += 2;
            continue;
          }
          value += c;
          pos += 1;
        }
        if (closed || i + 1 >= lines.length) break;
        // The quoted value continues on the next line.
        value += "\n";
        rest = lines[++i];
        pos = 0;
      }
      out[m[1]] = value;
      continue;
    }
    let value = rest;
    while (value.endsWith("\\") && i + 1 < lines.length) value = `${value.slice(0, -1)}${lines[++i].trim()}`;
    out[m[1]] = value.trim();
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

/**
 * Remove an environment variable line from an env file atomically (mode 0600),
 * best-effort. Returns true if modified, false otherwise.
 */
export function removeEnvVar(file: string, varName: string): boolean {
  try {
    if (!existsSync(file)) return false;
    const text = readFileSync(file, "utf8");
    const re = new RegExp(`^(?:export\\s+)?${varName}\\s*=.*(?:\\r?\\n)?`, "gm");
    if (!re.test(text)) return false;
    const updated = text.replace(new RegExp(`^(?:export\\s+)?${varName}\\s*=.*(?:\\r?\\n)?`, "gm"), "");
    writeFileAtomic(file, updated);
    return true;
  } catch {
    return false;
  }
}
