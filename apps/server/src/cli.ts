import { resolveApiKey, rotateApiKey } from "./apiKey.js";
import { ConfigError, loadConfig, type Config } from "./config.js";

const [group, action] = process.argv.slice(2);

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`chirp: invalid configuration: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

if (group === "key" && action === "show") {
  console.log(resolveApiKey(config).key);
} else if (group === "key" && action === "rotate") {
  const key = rotateApiKey(config);
  if (config.apiKey) {
    console.error("warning: CHIRP_API_KEY is set and takes precedence over the key file; unset it for the rotation to apply.");
  }
  console.log(key);
} else {
  console.error("usage: node apps/server/dist/cli.js key show|rotate");
  process.exit(2);
}
