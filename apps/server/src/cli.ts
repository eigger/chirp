import { readFileSync } from "node:fs";
import { AdminExistsError, AdminStore, InvalidUsernameError, WeakPasswordError } from "./admin.js";
import { resolveApiKey, rotateApiKey } from "./apiKey.js";
import { dataFiles } from "./auth.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { generatePassword } from "./password.js";
import { SetupCode } from "./setupCode.js";

const USAGE = `usage: node apps/server/dist/cli.js <command>

  admin create [--username NAME] [--password-stdin]
                                 create the admin account (default username "admin"); without
                                 --password-stdin a random password is generated and printed
  admin reset-password [--password-stdin]
                                 set a new password (random unless --password-stdin); signs out every session
  admin show-user                print the admin username
  admin setup-code               print the one-time setup code for the dashboard's setup form
  key show                       print the legacy API key (CHIRP_API_KEY or the api-key file)
  key rotate                     write a new legacy API key to the api-key file and print it

API keys for Home Assistant are normally created in the dashboard: Settings -> API keys.`;

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
function option(name: string): string | null {
  const i = rest.indexOf(name);
  if (i < 0) return null;
  const v = rest[i + 1];
  if (!v || v.startsWith("--")) fail(`${name} needs a value`, 2);
  return v;
}

/** First line of stdin (passwords never go on the command line, where `ps` and shell history see them). */
function passwordFromStdin(): string {
  const line = readFileSync(0, "utf8").split(/\r?\n/)[0] ?? "";
  if (!line) fail("no password on stdin");
  return line;
}

function explain(err: unknown): never {
  if (err instanceof AdminExistsError) fail("An admin account already exists. Use: admin reset-password");
  if (err instanceof InvalidUsernameError) fail(err.message);
  if (err instanceof WeakPasswordError) {
    fail(err.problem === "too_short" ? "Password is too short (minimum 10 characters)" : "Password is too long");
  }
  throw err;
}

const files = dataFiles(config.dataDir);
const admin = new AdminStore(files.admin);
const setup = new SetupCode(files.setupCode);

if (group === "admin" && action === "create") {
  const username = option("--username") ?? "admin";
  const fromStdin = flag("--password-stdin");
  if (admin.exists()) explain(new AdminExistsError());
  const password = fromStdin ? passwordFromStdin() : generatePassword();
  try {
    await admin.create(username, password);
  } catch (err) {
    explain(err);
  }
  setup.clear();
  console.log(`username: ${username}`);
  if (!fromStdin) console.log(`password: ${password}`);
} else if (group === "admin" && action === "reset-password") {
  if (!admin.exists()) fail("No admin account exists yet. Use: admin create");
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
  if (!name) fail("No admin account exists yet. Use: admin create (or admin setup-code for the dashboard's setup form)");
  console.log(name);
} else if (group === "admin" && action === "setup-code") {
  if (admin.exists()) fail("An admin account already exists, so there is no setup code. Forgot the password? Use: admin reset-password");
  console.log(setup.ensure());
} else if (group === "key" && action === "show") {
  const resolved = resolveApiKey(config);
  if (!resolved) {
    fail(
      "No legacy API key is configured (neither CHIRP_API_KEY nor " +
        `${config.apiKeyFile}). Create API keys in the dashboard: Settings -> API keys.`,
    );
  }
  console.log(resolved.key);
} else if (group === "key" && action === "rotate") {
  const key = rotateApiKey(config);
  if (config.apiKey) {
    console.error("warning: CHIRP_API_KEY is set and takes precedence over the key file; unset it for the rotation to apply.");
  }
  console.log(key);
} else {
  fail(USAGE, 2);
}
