import type { DocumentRole } from "../../shared/limits.js";
import type { Queryable } from "../db/index.js";
import { forbidden, notFound } from "./errors.js";
import { isUuid } from "./text.js";

/** What a caller needs to be able to do with a document. */
export type AccessNeed = "read" | "edit" | "own";

export interface DocumentAccess {
  documentId: string;
  ownerId: string;
  role: DocumentRole;
}

const FORBIDDEN_MESSAGES: Record<Exclude<AccessNeed, "read">, string> = {
  edit: "You have view-only access to this document",
  own: "Only the document owner can do this",
};

/**
 * THE access check. Every document and document-child operation goes through here.
 *
 * - malformed id, missing document, or no relationship to the document -> not_found
 *   (existence is never leaked to users without access)
 * - has access but insufficient role -> forbidden
 */
export async function authorizeDocument(
  q: Queryable,
  userId: string,
  documentId: unknown,
  need: AccessNeed,
): Promise<DocumentAccess> {
  if (!isUuid(documentId)) throw notFound();
  const { rows } = await q.query<{ owner_id: string; share_role: "viewer" | "editor" | null }>(
    `SELECT d.owner_id, s.role AS share_role
       FROM documents d
       LEFT JOIN document_shares s ON s.document_id = d.id AND s.user_id = $2
      WHERE d.id = $1`,
    [documentId, userId],
  );
  const row = rows[0];
  if (!row) throw notFound();

  let role: DocumentRole;
  if (row.owner_id === userId) role = "owner";
  else if (row.share_role) role = row.share_role;
  else throw notFound();

  if (need === "edit" && role === "viewer") throw forbidden(FORBIDDEN_MESSAGES.edit);
  if (need === "own" && role !== "owner") throw forbidden(FORBIDDEN_MESSAGES.own);

  return { documentId, ownerId: row.owner_id, role };
}
