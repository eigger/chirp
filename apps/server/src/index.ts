import { ApiKeyStore } from "./apiKey.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { loadInstanceId } from "./instanceId.js";
import { Collector, defaultDeps } from "./scheduler.js";
import { VERSION } from "./version.js";

const config = loadConfig();
const { store, created, key } = ApiKeyStore.fromConfig(config);
const instanceId = loadInstanceId(config.dataDir, (m) => console.warn(m));

const collector = new Collector(defaultDeps(config), {
  instanceId,
  version: VERSION,
  displayName: config.displayName,
  sensorIntervalSec: config.sensorIntervalSec,
  smartIntervalSec: config.smartIntervalSec,
  concurrency: 2,
});

const app = await buildApp({ config, collector, keys: store, logger: true });

if (config.rejected.length) {
  app.log.warn(`Ignoring unsafe CHIRP_DEVICES/CHIRP_DEVICE_TYPES entries: ${config.rejected.join(", ")}`);
}

if (created) {
  app.log.warn(`Generated a new API key (shown once; retrieve later with "node apps/server/dist/cli.js key show"): ${key}`);
}

collector.start();

const shutdown = async () => {
  collector.stop();
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: config.port, host: config.host });
