import type { Express } from "express";
import { createApp } from "./app.js";
import type { ServerConfig } from "./config.js";
import { openDatabase } from "./db/index.js";
import { consoleLogger } from "./http/errors.js";

/** Opens the database, builds the app, listens, and closes cleanly on SIGINT/SIGTERM. */
export async function startServer(
  config: ServerConfig,
  mountFrontend: ((app: Express) => void) | undefined,
): Promise<void> {
  const logger = consoleLogger;
  if (config.usingDevSecret) {
    logger.info("[warn] SESSION_SECRET not set; using the development fallback secret.");
  }
  if (config.production && !config.databaseUrl) {
    logger.info(
      `[warn] DATABASE_URL not set in production; using PGlite at ${config.pgliteDir} (lost on ephemeral disks).`,
    );
  }

  const db = await openDatabase({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir });
  const app = createApp({
    db,
    sessionSecret: config.sessionSecret,
    production: config.production,
    logger,
    mountFrontend,
  });

  const server = app.listen(config.port, () => {
    const storage = config.databaseUrl ? "Postgres (DATABASE_URL)" : `PGlite (${config.pgliteDir})`;
    logger.info(`Ajaia Docs listening on http://localhost:${config.port} using ${storage}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down`);
    server.close(() => {
      db.close()
        .catch((err: unknown) => logger.error("Error closing database", err))
        .finally(() => process.exit(0));
    });
    // Do not hang forever on keep-alive connections.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
