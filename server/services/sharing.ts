import type { Share } from "../../shared/api.js";
import { SHARE_ROLES, type ShareRole } from "../../shared/limits.js";
import type { Db } from "../db/index.js";
import { authorizeDocument } from "./access.js";
import { notFound, validationError } from "./errors.js";
import { asObject, toIso } from "./input.js";
import { isUuid } from "./text.js";

export type { Share };

interface ShareRow {
  user_id: string;
  name: string;
  email: string;
  role: ShareRole;
  created_at: Date;
  updated_at: Date;
}

function toShare(row: ShareRow): Share {
  return {
    user: { id: row.user_id, name: row.name, email: row.email },
    role: row.role,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function isShareRole(value: unknown): value is ShareRole {
  return typeof value === "string" && (SHARE_ROLES as readonly string[]).includes(value);
}

/** Owner-only: who else has access. */
export async function listShares(db: Db, userId: string, documentId: unknown): Promise<Share[]> {
  const access = await authorizeDocument(db, userId, documentId, "own");
  const { rows } = await db.query<ShareRow>(
    `SELECT s.user_id, u.name, u.email, s.role, s.created_at, s.updated_at
       FROM document_shares s JOIN users u ON u.id = s.user_id
      WHERE s.document_id = $1
      ORDER BY u.name, u.id`,
    [access.documentId],
  );
  return rows.map(toShare);
}

/**
 * Owner-only grant or role change (upsert: re-sharing updates the role, never
 * duplicates). Rejects self/owner, unknown users and invalid roles (EC-10).
 */
export async function upsertShare(
  db: Db,
  userId: string,
  documentId: unknown,
  body: unknown,
): Promise<{ share: Share; created: boolean }> {
  return db.transaction(async (tx) => {
    const access = await authorizeDocument(tx, userId, documentId, "own");
    const input = asObject(body);
    if (!isShareRole(input.role)) throw validationError("role must be 'viewer' or 'editor'");
    if (typeof input.userId !== "string" || input.userId.length === 0) {
      throw validationError("userId is required");
    }
    if (!isUuid(input.userId)) throw validationError("Unknown user");
    // Resolve the target first and compare canonical ids: UUIDs are case-insensitive,
    // so the raw request string must never be compared to the owner id (EC-10).
    const target = await tx.query<{ id: string }>("SELECT id::text AS id FROM users WHERE id = $1", [input.userId]);
    const targetId = target.rows[0]?.id.toLowerCase();
    if (!targetId) throw validationError("Unknown user");
    if (targetId === access.ownerId.toLowerCase()) {
      throw validationError("You can't share a document with its owner");
    }

    const { rows } = await tx.query<{ created: boolean }>(
      `INSERT INTO document_shares (document_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (document_id, user_id)
       DO UPDATE SET role = EXCLUDED.role, updated_at = now()
       RETURNING (xmax = 0) AS created`,
      [access.documentId, targetId, input.role],
    );
    const share = await tx.query<ShareRow>(
      `SELECT s.user_id, u.name, u.email, s.role, s.created_at, s.updated_at
         FROM document_shares s JOIN users u ON u.id = s.user_id
        WHERE s.document_id = $1 AND s.user_id = $2`,
      [access.documentId, targetId],
    );
    const row = share.rows[0];
    if (!row) throw notFound("Share not found");
    return { share: toShare(row), created: rows[0]?.created === true };
  });
}

/** Owner-only revoke. Takes effect immediately for every subsequent request. */
export async function revokeShare(
  db: Db,
  userId: string,
  documentId: unknown,
  targetUserId: unknown,
): Promise<void> {
  const access = await authorizeDocument(db, userId, documentId, "own");
  if (!isUuid(targetUserId)) throw notFound("Share not found");
  const { rows } = await db.query<{ user_id: string }>(
    "DELETE FROM document_shares WHERE document_id = $1 AND user_id = $2 RETURNING user_id",
    [access.documentId, targetUserId],
  );
  if (!rows[0]) throw notFound("Share not found");
}
