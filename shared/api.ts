/**
 * Response shapes of the REST API. The server services return these types and the
 * client consumes them, so both sides are type-checked against one definition.
 */
import type { DocumentRole, ShareRole } from "./limits.js";

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface DocumentSummary {
  id: string;
  title: string;
  role: DocumentRole;
  owner: { id: string; name: string };
  createdAt: string;
  updatedAt: string;
}

export interface DocumentDetail extends DocumentSummary {
  content: string;
  revision: number;
}

export interface DocumentLists {
  owned: DocumentSummary[];
  shared: DocumentSummary[];
}

export interface SaveResult {
  revision: number;
  updatedAt: string;
}

/** Body of a 409 response to a stale save. */
export interface ConflictBody {
  error: string;
  currentRevision: number;
}

export interface Share {
  user: User;
  role: ShareRole;
  createdAt: string;
  updatedAt: string;
}

export type VersionSource = "save" | "import" | "restore";

export interface VersionSummary {
  id: string;
  revision: number;
  source: VersionSource;
  restoredFromRevision: number | null;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
}

export interface VersionDetail extends VersionSummary {
  content: string;
}

export interface RestoreResult {
  revision: number;
  content: string;
  updatedAt: string;
  restoredFromRevision: number;
}

export interface ErrorBody {
  error: string;
}
