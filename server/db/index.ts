import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { migrate } from "./schema.js";

/** Minimal query surface shared by PGlite, a pg Pool and a transaction handle. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  readonly kind: "pglite" | "postgres";
  /** Runs `fn` in a single transaction; rolls back if it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Wraps a PGlite instance. PGlite is a single connection; its `transaction` helper
 * serialises transactions, so concurrent callers are queued, never interleaved.
 */
export function wrapPglite(pglite: PGlite): Db {
  return {
    kind: "pglite",
    async query<T>(sql: string, params?: unknown[]) {
      const res = await pglite.query<T>(sql, params as unknown[] | undefined);
      return { rows: res.rows };
    },
    transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return pglite.transaction(async (tx) =>
        fn({
          async query<R>(sql: string, params?: unknown[]) {
            const res = await tx.query<R>(sql, params as unknown[] | undefined);
            return { rows: res.rows };
          },
        }),
      );
    },
    close: () => pglite.close(),
  };
}

/** Opens an in-memory (dataDir undefined) or on-disk PGlite database. */
export async function openPglite(dataDir?: string): Promise<Db> {
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const pglite = await PGlite.create(dataDir);
  return wrapPglite(pglite);
}

function wantsSsl(connectionString: string): boolean {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return true;
  }
  const mode = url.searchParams.get("sslmode");
  if (mode === "disable") return false;
  return !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
}

/** Opens a pooled connection to a real Postgres server (e.g. Neon). */
export function openPostgres(connectionString: string): Db {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    // Neon requires TLS. If the URL carries its own sslmode it takes precedence.
    ssl: wantsSsl(connectionString) ? { rejectUnauthorized: true } : undefined,
  });
  return {
    kind: "postgres",
    async query<T>(sql: string, params?: unknown[]) {
      const res = await pool.query(sql, params);
      return { rows: res.rows as T[] };
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          async query<R>(sql: string, params?: unknown[]) {
            const res = await client.query(sql, params);
            return { rows: res.rows as R[] };
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // connection already broken; the original error is more useful
        }
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export interface DatabaseConfig {
  databaseUrl: string | null;
  /** PGlite directory; `null` means in-memory. Ignored when databaseUrl is set. */
  pgliteDir: string | null;
}

/** Opens the configured database and applies the idempotent schema + seed. */
export async function openDatabase(config: DatabaseConfig): Promise<Db> {
  const db = config.databaseUrl
    ? openPostgres(config.databaseUrl)
    : await openPglite(config.pgliteDir ?? undefined);
  try {
    await migrate(db);
  } catch (err) {
    await db.close().catch(() => undefined);
    throw err;
  }
  return db;
}
