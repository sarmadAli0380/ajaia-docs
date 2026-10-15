import { randomUUID } from "node:crypto";
import type { DocumentDetail, DocumentLists, DocumentSummary, SaveResult } from "../../shared/api.js";
import { MAX_CONTENT_BYTES, formatBytes, type DocumentRole } from "../../shared/limits.js";
import type { Db } from "../db/index.js";
import { authorizeDocument } from "./access.js";
import { conflict, notFound, tooLarge, validationError } from "./errors.js";
import { asObject, asRevision, toIso } from "./input.js";
import { sanitizeDocumentHtml } from "./sanitize.js";
import { parseTitle, utf8Bytes } from "./text.js";
import { recordVersion } from "./versions.js";

export type { DocumentDetail, DocumentSummary, SaveResult };

interface DocumentRow {
  id: string;
  title: string;
  owner_id: string;
  owner_name: string;
  created_at: Date;
  updated_at: Date;
  role?: DocumentRole;
  content?: string;
  revision?: number;
}

function toSummary(row: DocumentRow, role: DocumentRole): DocumentSummary {
  return {
    id: row.id,
    title: row.title,
    role,
    owner: { id: row.owner_id, name: row.owner_name },
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const SELECT_DOC = `
  SELECT d.id, d.title, d.owner_id, u.name AS owner_name, d.created_at, d.updated_at`;

export async function listDocuments(
  db: Db,
  userId: string,
): Promise<DocumentLists> {
  const owned = await db.query<DocumentRow>(
    `${SELECT_DOC}
       FROM documents d JOIN users u ON u.id = d.owner_id
      WHERE d.owner_id = $1
      ORDER BY d.updated_at DESC, d.id`,
    [userId],
  );
  const shared = await db.query<DocumentRow>(
    `${SELECT_DOC}, s.role
       FROM document_shares s
       JOIN documents d ON d.id = s.document_id
       JOIN users u ON u.id = d.owner_id
      WHERE s.user_id = $1 AND d.owner_id <> $1
      ORDER BY d.updated_at DESC, d.id`,
    [userId],
  );
  return {
    owned: owned.rows.map((r) => toSummary(r, "owner")),
    shared: shared.rows.map((r) => toSummary(r, r.role ?? "viewer")),
  };
}

export async function getDocument(db: Db, userId: string, documentId: unknown): Promise<DocumentDetail> {
  const access = await authorizeDocument(db, userId, documentId, "read");
  const { rows } = await db.query<DocumentRow>(
    `${SELECT_DOC}, d.content, d.revision
       FROM documents d JOIN users u ON u.id = d.owner_id
      WHERE d.id = $1`,
    [access.documentId],
  );
  const row = rows[0];
  if (!row) throw notFound();
  return { ...toSummary(row, access.role), content: row.content ?? "", revision: row.revision ?? 1 };
}

/** Validates raw HTML against the size limit (EC-4) and sanitizes it. */
export function prepareContent(raw: string): string {
  if (utf8Bytes(raw) > MAX_CONTENT_BYTES) {
    throw tooLarge(`Document is too large (maximum ${formatBytes(MAX_CONTENT_BYTES)})`);
  }
  const clean = sanitizeDocumentHtml(raw);
  if (utf8Bytes(clean) > MAX_CONTENT_BYTES) {
    throw tooLarge(`Document is too large (maximum ${formatBytes(MAX_CONTENT_BYTES)})`);
  }
  return clean;
}

/**
 * Inserts a new document owned by `userId`. When `initialVersionSource` is given the
 * initial content is also recorded as revision 1 in the history (imports).
 */
async function insertDocument(
  db: Db,
  userId: string,
  title: string,
  content: string,
  initialVersionSource: "import" | null,
): Promise<DocumentDetail> {
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO documents (id, owner_id, title, content, revision) VALUES ($1, $2, $3, $4, 1)`,
      [id, userId, title, content],
    );
    if (initialVersionSource) {
      await recordVersion(tx, { documentId: id, revision: 1, content, source: initialVersionSource, userId });
    }
  });
  return getDocument(db, userId, id);
}

export async function createDocument(db: Db, userId: string, body: unknown): Promise<DocumentDetail> {
  // An absent body is allowed (default title); a present one must be an object.
  const input = body === undefined ? {} : asObject(body);
  const title = parseTitle(input.title, { required: false });
  return insertDocument(db, userId, title, "", null);
}

/** Used by the importer once a file has been converted to (unsanitized) HTML. */
export async function createImportedDocument(
  db: Db,
  userId: string,
  title: string,
  html: string,
): Promise<DocumentDetail> {
  return insertDocument(db, userId, title, prepareContent(html), "import");
}

export async function renameDocument(
  db: Db,
  userId: string,
  documentId: unknown,
  body: unknown,
): Promise<DocumentSummary> {
  const input = asObject(body);
  const title = parseTitle(input.title, { required: true });
  return db.transaction(async (tx) => {
    const access = await authorizeDocument(tx, userId, documentId, "edit");
    // Title is independent of content: renaming does not bump the content revision,
    // so an open editor's next save is not turned into a conflict by a rename.
    const { rows } = await tx.query<DocumentRow>(
      `UPDATE documents d SET title = $2, updated_at = now()
         FROM users u
        WHERE d.id = $1 AND u.id = d.owner_id
        RETURNING d.id, d.title, d.owner_id, u.name AS owner_name, d.created_at, d.updated_at`,
      [access.documentId, title],
    );
    const row = rows[0];
    if (!row) throw notFound();
    return toSummary(row, access.role);
  });
}

/**
 * Saves content with optimistic concurrency. The revision check and the write are a
 * single conditional UPDATE, so two saves based on the same revision can never both
 * succeed; the version snapshot is written in the same transaction.
 */
export async function saveContent(
  db: Db,
  userId: string,
  documentId: unknown,
  body: unknown,
): Promise<SaveResult> {
  const input = asObject(body);
  if (typeof input.content !== "string") throw validationError("content must be a string");
  const baseRevision = asRevision(input.baseRevision, "baseRevision");
  const content = prepareContent(input.content);

  return db.transaction(async (tx) => {
    const access = await authorizeDocument(tx, userId, documentId, "edit");
    const { rows } = await tx.query<{ revision: number; updated_at: Date }>(
      `UPDATE documents SET content = $3, revision = revision + 1, updated_at = now()
        WHERE id = $1 AND revision = $2
        RETURNING revision, updated_at`,
      [access.documentId, baseRevision, content],
    );
    const updated = rows[0];
    if (!updated) {
      const current = await tx.query<{ revision: number }>("SELECT revision FROM documents WHERE id = $1", [
        access.documentId,
      ]);
      const currentRevision = current.rows[0]?.revision;
      if (currentRevision === undefined) throw notFound();
      throw conflict("This document was changed by someone else since you opened it", { currentRevision });
    }
    await recordVersion(tx, {
      documentId: access.documentId,
      revision: updated.revision,
      content,
      source: "save",
      userId,
    });
    return { revision: updated.revision, updatedAt: toIso(updated.updated_at) };
  });
}

/** Owner-only. Shares and versions are removed by ON DELETE CASCADE (EC-22). */
export async function deleteDocument(db: Db, userId: string, documentId: unknown): Promise<void> {
  await db.transaction(async (tx) => {
    const access = await authorizeDocument(tx, userId, documentId, "own");
    await tx.query("DELETE FROM documents WHERE id = $1", [access.documentId]);
  });
}
