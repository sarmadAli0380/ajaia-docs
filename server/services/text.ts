import { DEFAULT_TITLE, MAX_TITLE_LENGTH } from "../../shared/limits.js";
import { validationError } from "./errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Makes a string safe to store in a Postgres UTF-8 text column: removes NUL
 * characters (rejected by Postgres) and replaces lone UTF-16 surrogates (not
 * encodable as UTF-8) with U+FFFD.
 */
export function toStorableText(value: string): string {
  return value.replace(/\u0000/g, "").replace(LONE_SURROGATE_RE, "�");
}

/** Length in Unicode code points (so an emoji counts as one character). */
export function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

export function truncateCodePoints(value: string, max: number): string {
  if (codePointLength(value) <= max) return value;
  return Array.from(value).slice(0, max).join("");
}

// C0/C1 control characters and Unicode line/paragraph separators.
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

/** Collapses control characters and whitespace runs to single spaces and trims. */
export function normalizeTitleText(value: string): string {
  return toStorableText(value).replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
}

/**
 * Validates a user-supplied title (EC-1). Titles are plain text: any HTML inside is
 * stored verbatim and must be rendered as text by clients.
 */
export function parseTitle(value: unknown, { required }: { required: boolean }): string {
  if (value === undefined && !required) return DEFAULT_TITLE;
  if (value === undefined || value === null) throw validationError("Title is required");
  if (typeof value !== "string") throw validationError("Title must be a string");
  const title = normalizeTitleText(value);
  if (title.length === 0) throw validationError("Title cannot be empty");
  if (codePointLength(title) > MAX_TITLE_LENGTH) {
    throw validationError(`Title must be at most ${MAX_TITLE_LENGTH} characters`);
  }
  return title;
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
