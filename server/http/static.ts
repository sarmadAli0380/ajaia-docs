import { existsSync } from "node:fs";
import path from "node:path";
import express, { type Express } from "express";

/** CSP for the built SPA: no inline or third-party scripts. */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Serves the Vite production bundle and falls back to index.html for client-side
 * routes. /api is handled earlier, so unknown API paths still get JSON 404s.
 */
export function serveClient(clientDir: string): (app: Express) => void {
  const indexPath = path.join(clientDir, "index.html");
  if (!existsSync(indexPath)) {
    throw new Error(`Client bundle not found at ${indexPath}. Run "npm run build" first.`);
  }
  const assetsDir = `${path.sep}assets${path.sep}`;
  return (app) => {
    app.use(
      express.static(clientDir, {
        index: false,
        setHeaders: (res, filePath) => {
          if (filePath.includes(assetsDir)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        },
      }),
    );
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
      res.setHeader("Cache-Control", "no-cache");
      // `root` keeps the dotfile check on the relative name only, so installs under a
      // hidden directory (e.g. /srv/.apps/docs) still work.
      res.sendFile("index.html", { root: clientDir }, (err) => {
        if (err) next(err);
      });
    });
  };
}
