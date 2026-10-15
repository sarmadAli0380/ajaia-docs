import express, { type Express } from "express";
import type { Db } from "./db/index.js";
import { consoleLogger, errorHandler, type Logger } from "./http/errors.js";
import { apiRouter } from "./routes/api.js";

export interface AppOptions {
  db: Db;
  sessionSecret: string;
  /** Production enables Secure cookies and `trust proxy`. */
  production?: boolean;
  logger?: Logger;
  /** Clock injection for tests (session expiry). */
  now?: () => number;
  /** Mounts the SPA (static bundle in production, Vite middleware in dev). */
  mountFrontend?: (app: Express) => void;
}

/** JSON body limit: above the 1 MB content limit so the service can answer 413 itself. */
const JSON_BODY_LIMIT = "3mb";

export function createApp(options: AppOptions): Express {
  const production = options.production ?? false;
  const logger = options.logger ?? consoleLogger;
  const app = express();

  app.disable("x-powered-by");
  // Render (and most PaaS) terminate TLS at a proxy in front of the app.
  if (production) app.set("trust proxy", 1);

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  app.use(
    "/api",
    (_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      next();
    },
    express.json({ limit: JSON_BODY_LIMIT }),
    apiRouter({
      db: options.db,
      sessionSecret: options.sessionSecret,
      production,
      now: options.now ?? Date.now,
      logger,
    }),
  );

  options.mountFrontend?.(app);

  app.use(errorHandler(logger));
  return app;
}
