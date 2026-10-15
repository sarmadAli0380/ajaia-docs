import { createHmac, timingSafeEqual } from "node:crypto";
import type { Queryable } from "../db/index.js";
import { validationError } from "./errors.js";
import { asObject } from "./input.js";
import { findUser, type User } from "./users.js";

/** Sessions last a week; the cookie Max-Age matches. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Tolerated clock skew for tokens issued "in the future". */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

interface SessionPayload {
  uid: string;
  iat: number;
}

function hmac(secret: string, data: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

/** `<base64url(json)>.<base64url(hmac-sha256)>` */
export function signSession(secret: string, userId: string, issuedAt: number): string {
  const body = Buffer.from(JSON.stringify({ uid: userId, iat: issuedAt } satisfies SessionPayload)).toString(
    "base64url",
  );
  return `${body}.${hmac(secret, body).toString("base64url")}`;
}

/** Returns the user id for a valid, unexpired token, otherwise null. Never throws. */
export function verifySession(secret: string, token: string | undefined, now: number): string | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const body = token.slice(0, dot);
  // Compare the canonical encodings so non-canonical base64url variants of a valid
  // signature (differing only in ignored trailing bits) are rejected too.
  const given = Buffer.from(token.slice(dot + 1), "utf8");
  const expected = Buffer.from(hmac(secret, body).toString("base64url"), "utf8");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const { uid, iat } = payload as Partial<SessionPayload>;
  if (typeof uid !== "string" || typeof iat !== "number" || !Number.isFinite(iat)) return null;
  if (iat > now + MAX_CLOCK_SKEW_MS || now - iat > SESSION_TTL_MS) return null;
  return uid;
}

/** Mocked sign-in: any seeded user may be chosen; there is no password. */
export async function signIn(q: Queryable, body: unknown): Promise<User> {
  const input = asObject(body);
  if (typeof input.userId !== "string") throw validationError("userId is required");
  const user = await findUser(q, input.userId);
  if (!user) throw validationError("Unknown user");
  return user;
}

/** Resolves the user behind a token; deleted users or bad tokens yield null. */
export async function userForToken(
  q: Queryable,
  secret: string,
  token: string | undefined,
  now: number,
): Promise<User | null> {
  const userId = verifySession(secret, token, now);
  if (!userId) return null;
  return findUser(q, userId);
}
