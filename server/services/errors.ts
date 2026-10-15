/**
 * Domain errors raised by services. Transport adapters map `kind` to a status code;
 * services never know about HTTP.
 */
export type DomainErrorKind =
  | "validation" // bad input -> 400
  | "unauthenticated" // no / invalid session -> 401
  | "forbidden" // has access but not enough role -> 403
  | "not_found" // missing, or no access at all (do not leak existence) -> 404
  | "conflict" // stale revision -> 409
  | "too_large" // content/upload over limit -> 413
  | "unsupported_type"; // import extension not supported -> 415

export class DomainError extends Error {
  readonly kind: DomainErrorKind;
  readonly details: Record<string, unknown> | undefined;

  constructor(kind: DomainErrorKind, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DomainError";
    this.kind = kind;
    this.details = details;
  }
}

export const validationError = (message: string) => new DomainError("validation", message);
export const notFound = (message = "Document not found") => new DomainError("not_found", message);
export const forbidden = (message: string) => new DomainError("forbidden", message);
export const conflict = (message: string, details?: Record<string, unknown>) =>
  new DomainError("conflict", message, details);
export const tooLarge = (message: string) => new DomainError("too_large", message);
export const unsupportedType = (message: string) => new DomainError("unsupported_type", message);
export const unauthenticated = (message = "Not signed in") => new DomainError("unauthenticated", message);
