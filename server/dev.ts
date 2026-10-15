/**
 * Development entry point (`npm run dev`): one process serves the API and the SPA
 * through Vite's middleware (HMR included). Not part of the production build.
 */
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { ConfigError, loadConfig } from "./config.js";
import { startServer } from "./start.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const vite = await createViteServer({
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    server: { middlewareMode: true },
    appType: "spa",
  });
  await startServer(config, (app) => {
    app.use(vite.middlewares);
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? `Configuration error: ${err.message}` : err);
  process.exit(1);
});
