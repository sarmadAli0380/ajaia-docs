/**
 * Production entry point (`npm start` -> node dist/node/server/index.js).
 * Serves the API and the built SPA from one process.
 */
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig } from "./config.js";
import { serveClient } from "./http/static.js";
import { startServer } from "./start.js";

async function main(): Promise<void> {
  const config = loadConfig();
  // Compiled layout: dist/node/server/index.js -> dist/client
  const clientDir = process.env.CLIENT_DIST_DIR ?? fileURLToPath(new URL("../../client/", import.meta.url));
  await startServer(config, serveClient(clientDir));
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? `Configuration error: ${err.message}` : err);
  process.exit(1);
});
