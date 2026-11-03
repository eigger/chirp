import { buildApp } from "./app.js";
import { createAuth } from "./auth.js";
import { bootstrapAuth } from "./bootstrap.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { loadInstanceId } from "./instanceId.js";
import { Collector, defaultDeps } from "./scheduler.js";
import { VERSION } from "./version.js";

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

const auth = createAuth(config);
const instanceId = loadInstanceId(config.dataDir, (m) => console.warn(m));

// The collector may warn before the app (and its logger) exists.
let warn: (msg: string) => void = (m) => console.warn(m);

const collector = new Collector(defaultDeps(config, (m) => warn(m)), {
  instanceId,
  version: VERSION,
  displayName: config.displayName,
  sensorIntervalSec: config.sensorIntervalSec,
  smartIntervalSec: config.smartIntervalSec,
  rescanIntervalSec: config.rescanIntervalSec,
  concurrency: 2,
});

const app = await buildApp({ config, collector, auth, logger: true });
warn = (m) => app.log.warn(m);

if (config.rejected.length) {
  app.log.warn(`Ignoring unsafe CHIRP_DEVICES/CHIRP_DEVICE_TYPES entries: ${config.rejected.join(", ")}`);
}

for (const n of await bootstrapAuth(config, auth)) app.log[n.level](n.msg);

collector.start();

const shutdown = async () => {
  collector.stop();
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: config.port, host: config.host });
