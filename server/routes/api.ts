/**
 * REST adapter. Handlers only translate HTTP <-> service calls; every rule lives in
 * ../services. Errors propagate to the JSON error handler (Express 5 forwards
 * rejected promises automatically).
 */
import { Router, type RequestHandler } from "express";
import multer from "multer";
import { MAX_UPLOAD_BYTES } from "../../shared/limits.js";
import {
  clearSessionCookie,
  currentUser,
  requireCsrfHeader,
  requireUser,
  sessionUser,
  setSessionCookie,
  type AuthOptions,
} from "../http/auth.js";
import { apiNotFound, type Logger } from "../http/errors.js";
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  renameDocument,
  saveContent,
} from "../services/documents.js";
import { unauthenticated } from "../services/errors.js";
import { exportMarkdown } from "../services/exporter.js";
import { importDocument } from "../services/importer.js";
import { signIn } from "../services/session.js";
import { listShares, revokeShare, upsertShare } from "../services/sharing.js";
import { getVersion, listVersions, restoreVersion } from "../services/versions.js";
import { listUsers } from "../services/users.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5, parts: 6 },
  // Browsers send multipart filenames as raw UTF-8.
  defParamCharset: "utf8",
}).single("file");

export function apiRouter(opts: AuthOptions & { logger: Logger }): Router {
  const { db } = opts;
  const r = Router();
  const auth = requireUser(opts);

  r.get("/health", async (_req, res) => {
    try {
      await db.query("SELECT 1");
      res.json({ status: "ok" });
    } catch (err) {
      opts.logger.error("Health check failed", err);
      res.status(503).json({ status: "unavailable" });
    }
  });

  // --- mocked auth -------------------------------------------------------------
  // Public by design: the login screen lists the seeded users.
  r.get("/users", async (_req, res) => {
    res.json({ users: await listUsers(db) });
  });

  r.get("/session", async (req, res) => {
    const user = await sessionUser(req, opts);
    if (!user) throw unauthenticated();
    res.json({ user });
  });

  r.post("/session", requireCsrfHeader, async (req, res) => {
    const user = await signIn(db, req.body);
    setSessionCookie(res, opts, user.id);
    res.json({ user });
  });

  r.delete("/session", requireCsrfHeader, (_req, res) => {
    clearSessionCookie(res, opts);
    res.status(204).end();
  });

  // --- documents (all require a session) ----------------------------------------
  r.use("/documents", auth);

  r.get("/documents", async (_req, res) => {
    res.json(await listDocuments(db, currentUser(res).id));
  });

  r.post("/documents", async (req, res) => {
    res.status(201).json({ document: await createDocument(db, currentUser(res).id, req.body) });
  });

  const parseUpload: RequestHandler = (req, res, next) => upload(req, res, (err?: unknown) => next(err));

  r.post("/documents/import", parseUpload, async (req, res) => {
    const file = req.file ? { originalName: req.file.originalname, buffer: req.file.buffer } : undefined;
    res.status(201).json({ document: await importDocument(db, currentUser(res).id, file) });
  });

  r.get("/documents/:id", async (req, res) => {
    res.json({ document: await getDocument(db, currentUser(res).id, req.params.id) });
  });

  r.patch("/documents/:id", async (req, res) => {
    res.json({ document: await renameDocument(db, currentUser(res).id, req.params.id, req.body) });
  });

  r.put("/documents/:id/content", async (req, res) => {
    res.json(await saveContent(db, currentUser(res).id, req.params.id, req.body));
  });

  r.delete("/documents/:id", async (req, res) => {
    await deleteDocument(db, currentUser(res).id, req.params.id);
    res.status(204).end();
  });

  r.get("/documents/:id/shares", async (req, res) => {
    res.json({ shares: await listShares(db, currentUser(res).id, req.params.id) });
  });

  r.post("/documents/:id/shares", async (req, res) => {
    const { share, created } = await upsertShare(db, currentUser(res).id, req.params.id, req.body);
    res.status(created ? 201 : 200).json({ share });
  });

  r.delete("/documents/:id/shares/:userId", async (req, res) => {
    await revokeShare(db, currentUser(res).id, req.params.id, req.params.userId);
    res.status(204).end();
  });

  r.get("/documents/:id/versions", async (req, res) => {
    res.json({ versions: await listVersions(db, currentUser(res).id, req.params.id) });
  });

  r.get("/documents/:id/versions/:versionId", async (req, res) => {
    res.json({ version: await getVersion(db, currentUser(res).id, req.params.id, req.params.versionId) });
  });

  r.post("/documents/:id/versions/:versionId/restore", async (req, res) => {
    res.json(await restoreVersion(db, currentUser(res).id, req.params.id, req.params.versionId));
  });

  r.get("/documents/:id/export", async (req, res) => {
    const result = await exportMarkdown(db, currentUser(res).id, req.params.id);
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", result.contentDisposition);
    res.send(result.markdown);
  });

  r.use(apiNotFound);
  return r;
}
