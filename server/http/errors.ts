import type { ErrorRequestHandler, RequestHandler } from "express";
import multer from "multer";
import { MAX_UPLOAD_BYTES, formatBytes } from "../../shared/limits.js";
import { DomainError, type DomainErrorKind } from "../services/errors.js";

export interface Logger {
  info(message: string): void;
  error(message: string, err?: unknown): void;
}

export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  error: (message, err) => console.error(message, err),
};

const STATUS_BY_KIND: Record<DomainErrorKind, number> = {
  validation: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  unsupported_type: 415,
};

export const GENERIC_ERROR_MESSAGE = "Something went wrong on our side. Please try again.";

function multerError(err: multer.MulterError): { status: number; message: string } {
  switch (err.code) {
    case "LIMIT_FILE_SIZE":
      return { status: 413, message: `File is too large (maximum ${formatBytes(MAX_UPLOAD_BYTES)})` };
    case "LIMIT_UNEXPECTED_FILE":
      return { status: 400, message: "Unexpected upload field. Send exactly one file in a field named 'file'." };
    default:
      return { status: 400, message: "Invalid upload" };
  }
}

/** Single JSON error boundary: never leaks stack traces, logs unexpected failures (EC-21). */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof DomainError) {
      res.status(STATUS_BY_KIND[err.kind]).json({ ...(err.details ?? {}), error: err.message });
      return;
    }
    if (err instanceof multer.MulterError) {
      const { status, message } = multerError(err);
      res.status(status).json({ error: message });
      return;
    }
    const e = err as { type?: unknown; status?: unknown; statusCode?: unknown; expose?: unknown } | null;
    if (e?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Malformed JSON in request body" });
      return;
    }
    if (e?.type === "entity.too.large") {
      res.status(413).json({ error: "Request body is too large" });
      return;
    }
    const status = typeof e?.status === "number" ? e.status : typeof e?.statusCode === "number" ? e.statusCode : 500;
    if (status >= 400 && status < 500 && e?.expose === true) {
      // Body-parser / multipart framing / static-file errors. Never echo internal messages.
      res.status(status).json({ error: status === 404 ? "Not found" : "Bad request" });
      return;
    }
    logger.error(`Unhandled error on ${req.method} ${req.originalUrl}`, err);
    res.status(500).json({ error: GENERIC_ERROR_MESSAGE });
  };
}

/** JSON 404 for unknown API routes (keeps the SPA fallback from swallowing them). */
export const apiNotFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "Not found" });
};
