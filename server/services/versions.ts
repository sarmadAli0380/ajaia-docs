import { randomUUID } from "node:crypto";
import type { RestoreResult, VersionDetail, VersionSource, VersionSummary } from "../../shared/api.js";
import { VERSION_RETENTION } from "../../shared/limits.js";
import type { Db, Queryable } from "../db/index.js";
import { authorizeDocument } from "./access.js";
import { notFound } from "./errors.js";
import { toIso } from "./input.js";
import { sanitizeDocumentHtml } from "./sanitize.js";
import { isUuid } from "./text.js";

export type { RestoreResult, VersionDetail, VersionSource, VersionSummary };

interface VersionRow {
  id: string;
  revision: number;
  source: VersionSource;
  restored_from_revision: number | null;
  created_at: Date;
  created_by: string | null;
  created_by_name: string | null;
  content?: string;
}

function toSummary(row: VersionRow): VersionSummary {
  return {
    id: row.id,
    revision: row.revision,
    source: row.source,
    restoredFromRevision: row.restored_from_revision,
    createdAt: toIso(row.created_at),
    createdBy: row.created_by && row.created_by_name ? { id: row.created_by, name: row.created_by_name } : null,
  };
}

/**
 * Records a snapshot and prunes beyond the retention cap. Must be called inside the
 * same transaction as the content change it records.
 */
export async function recordVersion(
  tx: Queryable,
  input: {
    documentId: string;
    revision: number;
    content: string;
    source: VersionSource;
    userId: string;
    restoredFromRevision?: number | null;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO document_versions (id, document_id, revision, content, source, restored_from_revision, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      input.documentId,
      input.revision,
      input.content,
      input.source,
      input.restoredFromRevision ?? null,
      input.userId,
    ],
  );
  await tx.query(
    `DELETE FROM document_versions
      WHERE document_id = $1
        AND revision <= (SELECT revision FROM document_versions
                          WHERE document_id = $1
                          ORDER BY revision DESC
                          OFFSET $2 LIMIT 1)`,
    [input.documentId, VERSION_RETENTION],
  );
}

const SELECT_VERSION = `
  SELECT v.id, v.revision, v.source, v.restored_from_revision, v.created_at,
         v.created_by, u.name AS created_by_name`;

export async function listVersions(db: Db, userId: string, documentId: unknown): Promise<VersionSummary[]> {
  const access = await authorizeDocument(db, userId, documentId, "read");
  const { rows } = await db.query<VersionRow>(
    `${SELECT_VERSION}
       FROM document_versions v LEFT JOIN users u ON u.id = v.created_by
      WHERE v.document_id = $1
      ORDER BY v.revision DESC`,
    [access.documentId],
  );
  return rows.map(toSummary);
}

async function findVersion(q: Queryable, documentId: string, versionId: unknown): Promise<VersionDetail> {
  if (!isUuid(versionId)) throw notFound("Version not found");
  // Scoped by document id: a version id from another document is simply "not found".
  const { rows } = await q.query<VersionRow>(
    `${SELECT_VERSION}, v.content
       FROM document_versions v LEFT JOIN users u ON u.id = v.created_by
      WHERE v.document_id = $1 AND v.id = $2`,
    [documentId, versionId],
  );
  const row = rows[0];
  if (!row) throw notFound("Version not found");
  return { ...toSummary(row), content: row.content ?? "" };
}

export async function getVersion(
  db: Db,
  userId: string,
  documentId: unknown,
  versionId: unknown,
): Promise<VersionDetail> {
  const access = await authorizeDocument(db, userId, documentId, "read");
  return findVersion(db, access.documentId, versionId);
}

/**
 * Makes a version the current content (owner/editor). Restore is an explicit user
 * choice, so it is not conditional on the client's revision; the previous content
 * remains available in history if it was saved. The restored content is sanitized
 * again so tightened rules apply to old snapshots too.
 */
export async function restoreVersion(
  db: Db,
  userId: string,
  documentId: unknown,
  versionId: unknown,
): Promise<RestoreResult> {
  return db.transaction(async (tx) => {
    const access = await authorizeDocument(tx, userId, documentId, "edit");
    const version = await findVersion(tx, access.documentId, versionId);
    const content = sanitizeDocumentHtml(version.content);
    const { rows } = await tx.query<{ revision: number; updated_at: Date }>(
      `UPDATE documents SET content = $2, revision = revision + 1, updated_at = now()
        WHERE id = $1
        RETURNING revision, updated_at`,
      [access.documentId, content],
    );
    const updated = rows[0];
    if (!updated) throw notFound();
    await recordVersion(tx, {
      documentId: access.documentId,
      revision: updated.revision,
      content,
      source: "restore",
      userId,
      restoredFromRevision: version.revision,
    });
    return {
      revision: updated.revision,
      content,
      updatedAt: toIso(updated.updated_at),
      restoredFromRevision: version.revision,
    };
  });
}
