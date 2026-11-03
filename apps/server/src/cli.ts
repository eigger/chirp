import { readFileSync } from "node:fs";
import { AdminStore, InvalidUsernameError, WeakPasswordError } from "./admin.js";
import { resolveApiKey, rotateApiKey } from "./apiKey.js";
import { adminFile } from "./auth.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { generatePassword } from "./password.js";

const USAGE = `usage: node apps/server/dist/cli.js <command>

  admin reset-password [--password-stdin]
                                 set a new admin password (random and printed unless --password-stdin);
                                 signs out every dashboard session
  admin show-user                print the admin username
  key show                       print the API key (CHIRP_API_KEY or the api-key file)
  key rotate                     write a new API key to the api-key file and print it

The admin account is created in the dashboard on first visit (or with CHIRP_ADMIN_USER/CHIRP_ADMIN_PASSWORD).
The API key is also shown, and can be regenerated, in the dashboard: Settings -> API key.`;

function fail(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) fail(`chirp: invalid configuration: ${err.message}`);
  throw err;
}

const [group, action, ...rest] = process.argv.slice(2);

function flag(name: string): boolean {
  return rest.includes(name);
}

/** First line of stdin (passwords never go on the command line, where `ps` and shell history see them). */
function passwordFromStdin(): string {
  const line = readFileSync(0, "utf8").split(/\r?\n/)[0] ?? "";
  if (!line) fail("no password on stdin");
  return line;
}

function explain(err: unknown): never {
  if (err instanceof InvalidUsernameError) fail(err.message);
  if (err instanceof WeakPasswordError) {
    fail(err.problem === "too_short" ? "Password is too short (minimum 10 characters)" : "Password is too long");
  }
  throw err;
}

const admin = new AdminStore(adminFile(config.dataDir));

if (group === "admin" && action === "reset-password") {
  if (!admin.exists()) fail("No admin account exists yet: open the dashboard and create it.");
  const fromStdin = flag("--password-stdin");
  const password = fromStdin ? passwordFromStdin() : generatePassword();
  try {
    await admin.setPassword(password);
  } catch (err) {
    explain(err);
  }
  console.log(`username: ${admin.username()}`);
  if (!fromStdin) console.log(`password: ${password}`);
  console.error("All dashboard sessions have been signed out.");
} else if (group === "admin" && action === "show-user") {
  const name = admin.username();
  if (!name) fail("No admin account exists yet: open the dashboard and create it.");
  console.log(name);
} else if (group === "key" && action === "show") {
  console.log(resolveApiKey(config).key);
} else if (group === "key" && action === "rotate") {
  const key = rotateApiKey(config);
  if (config.apiKey) {
    console.error("warning: CHIRP_API_KEY is set and takes precedence over the key file; unset it for the rotation to apply.");
  }
  console.log(key);
} else {
  fail(USAGE, 2);
}
