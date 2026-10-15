import { validationError } from "./errors.js";

/** Ensures a request body is a plain JSON object (EC-2). */
export function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validationError("Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

const MAX_INT4 = 2_147_483_647;

/** Positive 32-bit integer (revision numbers). */
export function asRevision(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_INT4) {
    throw validationError(`${field} must be a positive integer`);
  }
  return value;
}

export function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}
