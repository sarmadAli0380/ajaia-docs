import type { CookieOptions, Request, RequestHandler, Response } from "express";
import { CSRF_HEADER, CSRF_HEADER_VALUE } from "../../shared/limits.js";
import type { Db } from "../db/index.js";
import { forbidden, unauthenticated } from "../services/errors.js";
import { SESSION_TTL_MS, signSession, userForToken } from "../services/session.js";
import type { User } from "../services/users.js";

export const SESSION_COOKIE = "ajaia_session";

export interface AuthOptions {
  db: Db;
  sessionSecret: string;
  production: boolean;
  now: () => number;
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function cookieOptions(production: boolean): CookieOptions {
  return { httpOnly: true, sameSite: "lax", secure: production, path: "/" };
}

export function setSessionCookie(res: Response, opts: AuthOptions, userId: string): void {
  res.cookie(SESSION_COOKIE, signSession(opts.sessionSecret, userId, opts.now()), {
    ...cookieOptions(opts.production),
    maxAge: SESSION_TTL_MS,
  });
}

export function clearSessionCookie(res: Response, opts: AuthOptions): void {
  res.clearCookie(SESSION_COOKIE, cookieOptions(opts.production));
}

/** Resolves the signed-in user (or null) from the signed cookie. */
export async function sessionUser(req: Request, opts: AuthOptions): Promise<User | null> {
  return userForToken(opts.db, opts.sessionSecret, readCookie(req, SESSION_COOKIE), opts.now());
}

/** The authenticated user for a request that passed `requireUser`. */
export function currentUser(res: Response): User {
  const user = res.locals.user as User | undefined;
  if (!user) throw unauthenticated();
  return user;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Rejects state-changing requests that lack the custom header. Browsers cannot add
 * custom headers to cross-origin requests without a CORS preflight (which this
 * server never approves), so this complements SameSite=Lax as a CSRF defence.
 */
export const requireCsrfHeader: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.get(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
    return next(forbidden(`Missing ${CSRF_HEADER} header`));
  }
  next();
};

/** 401 unless a valid session cookie identifies an existing user; then the CSRF check. */
export function requireUser(opts: AuthOptions): RequestHandler {
  return async (req, res, next) => {
    const user = await sessionUser(req, opts);
    if (!user) return next(unauthenticated());
    res.locals.user = user;
    requireCsrfHeader(req, res, next);
  };
}
