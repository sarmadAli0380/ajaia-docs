import type { Db } from "./index.js";

/** Seeded (mocked-auth) users. Ids are stable so sessions and links survive restarts. */
export const SEED_USERS = [
  { id: "a11ce000-0000-4000-8000-000000000001", name: "Alice", email: "alice@ajaia.test" },
  { id: "b0b00000-0000-4000-8000-000000000002", name: "Bob", email: "bob@ajaia.test" },
  { id: "ca401000-0000-4000-8000-000000000003", name: "Carol", email: "carol@ajaia.test" },
] as const;

/** Arbitrary constant used to serialise concurrent boots against one Postgres. */
const BOOT_LOCK_KEY = 72_410_015;

/**
 * Statements are individually idempotent (IF NOT EXISTS). Executed one at a time
 * because PGlite's parameterised query path accepts a single statement.
 */
const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
     id uuid PRIMARY KEY,
     name text NOT NULL,
     email text NOT NULL UNIQUE
   )`,
  `CREATE TABLE IF NOT EXISTS documents (
     id uuid PRIMARY KEY,
     owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     title text NOT NULL,
     content text NOT NULL DEFAULT '',
     revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS documents_owner_idx ON documents (owner_id, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS document_shares (
     document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     role text NOT NULL CHECK (role IN ('viewer', 'editor')),
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (document_id, user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS document_shares_user_idx ON document_shares (user_id)`,
  `CREATE TABLE IF NOT EXISTS document_versions (
     id uuid PRIMARY KEY,
     document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     revision integer NOT NULL,
     content text NOT NULL,
     source text NOT NULL CHECK (source IN ('save', 'import', 'restore')),
     restored_from_revision integer,
     created_by uuid REFERENCES users(id) ON DELETE SET NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (document_id, revision)
   )`,
];

/** Creates tables and seeds users. Safe to run on every boot and from several instances at once. */
export async function migrate(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [BOOT_LOCK_KEY]);
    for (const statement of SCHEMA) {
      await tx.query(statement);
    }
    for (const user of SEED_USERS) {
      await tx.query(
        `INSERT INTO users (id, name, email) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [user.id, user.name, user.email],
      );
    }
  });
}
