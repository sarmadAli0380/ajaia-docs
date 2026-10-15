/**
 * Limits and enumerations shared by the server (authoritative enforcement) and the
 * client (early feedback / labels). Both sides import this single module so the
 * values cannot drift apart.
 */

/** Maximum size of an uploaded import file (bytes). */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** Maximum size of stored document HTML (UTF-8 bytes). */
export const MAX_CONTENT_BYTES = 1024 * 1024;

/** Maximum title length in Unicode code points (after trimming). */
export const MAX_TITLE_LENGTH = 200;

/** Default title for newly created documents. */
export const DEFAULT_TITLE = "Untitled document";

/** Number of version snapshots retained per document. */
export const VERSION_RETENTION = 50;

/** File extensions accepted by the importer (lower-case, with leading dot). */
export const SUPPORTED_IMPORT_EXTENSIONS = [".txt", ".md", ".docx"] as const;

export type ImportExtension = (typeof SUPPORTED_IMPORT_EXTENSIONS)[number];

/** Roles a document can be shared with. The owner role is implicit. */
export const SHARE_ROLES = ["viewer", "editor"] as const;

export type ShareRole = (typeof SHARE_ROLES)[number];

export type DocumentRole = "owner" | ShareRole;

/** Header required on every state-changing API request (CSRF defence in depth). */
export const CSRF_HEADER = "X-Requested-With";
export const CSRF_HEADER_VALUE = "ajaia-docs";

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}
