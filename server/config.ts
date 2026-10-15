export interface ServerConfig {
  production: boolean;
  port: number;
  sessionSecret: string;
  databaseUrl: string | null;
  /** PGlite data directory (used only when databaseUrl is null). */
  pgliteDir: string;
  /** True when the dev fallback secret is in use (logged as a warning). */
  usingDevSecret: boolean;
}

/** Development-only fallback. Never accepted in production. */
const DEV_SESSION_SECRET = "ajaia-docs-dev-only-session-secret-do-not-use-in-production";
const MIN_PRODUCTION_SECRET_LENGTH = 32;

export class ConfigError extends Error {}

/** Reads configuration from the environment; throws ConfigError on unsafe settings. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === "production";

  const rawPort = env.PORT ?? "3000";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 0 and 65535 (got "${rawPort}")`);
  }

  let sessionSecret = env.SESSION_SECRET?.trim() ?? "";
  let usingDevSecret = false;
  if (!sessionSecret) {
    if (production) throw new ConfigError("SESSION_SECRET is required when NODE_ENV=production");
    sessionSecret = DEV_SESSION_SECRET;
    usingDevSecret = true;
  } else if (production && sessionSecret.length < MIN_PRODUCTION_SECRET_LENGTH) {
    throw new ConfigError(`SESSION_SECRET must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production`);
  }
  if (production && sessionSecret === DEV_SESSION_SECRET) {
    throw new ConfigError("SESSION_SECRET must not be the development fallback in production");
  }

  return {
    production,
    port,
    sessionSecret,
    databaseUrl: env.DATABASE_URL?.trim() || null,
    pgliteDir: env.PGLITE_DIR?.trim() || ".data/pglite",
    usingDevSecret,
  };
}
