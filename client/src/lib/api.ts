import type {
  DocumentDetail,
  DocumentLists,
  DocumentSummary,
  RestoreResult,
  SaveResult,
  Share,
  User,
  VersionDetail,
  VersionSummary,
} from "../../../shared/api";
import { CSRF_HEADER, CSRF_HEADER_VALUE, type ShareRole } from "../../../shared/limits";

/** An HTTP response with a non-2xx status. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, message: string, body: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** The request never produced a response (offline, DNS, server down). */
export class NetworkError extends Error {
  constructor(message = "Can't reach the server. Check your connection and try again.") {
    super(message);
    this.name = "NetworkError";
  }
}

/** Dispatched on window whenever an API call returns 401 (EC-7). */
export const UNAUTHORIZED_EVENT = "ajaia:unauthorized";

interface RequestOptions {
  json?: unknown;
  form?: FormData;
  /** Do not broadcast 401s (used by the boot-time session probe). */
  quiet401?: boolean;
}

async function send(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") headers[CSRF_HEADER] = CSRF_HEADER_VALUE;
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.form) {
    body = options.form;
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body, credentials: "same-origin" });
  } catch {
    throw new NetworkError();
  }
  if (!res.ok) {
    let data: Record<string, unknown> = {};
    try {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
    } catch {
      // non-JSON error (e.g. proxy page) - fall through with a generic message
    }
    const message = typeof data.error === "string" ? data.error : `Request failed (${res.status})`;
    if (res.status === 401 && !options.quiet401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(res.status, message, data);
  }
  return res;
}

async function request<T>(method: string, path: string, options?: RequestOptions): Promise<T> {
  const res = await send(method, path, options);
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new NetworkError("The server sent an unreadable response. Please try again.");
  }
}

const doc = (id: string) => `/api/documents/${encodeURIComponent(id)}`;

function filenameFromDisposition(header: string | null): string {
  if (!header) return "document.md";
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // fall through to the ASCII name
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain?.[1] ?? "document.md";
}

export const api = {
  listUsers: () => request<{ users: User[] }>("GET", "/api/users").then((r) => r.users),
  getSession: () =>
    request<{ user: User }>("GET", "/api/session", { quiet401: true }).then((r) => r.user),
  signIn: (userId: string) =>
    request<{ user: User }>("POST", "/api/session", { json: { userId }, quiet401: true }).then((r) => r.user),
  signOut: () => request<void>("DELETE", "/api/session"),

  listDocuments: () => request<DocumentLists>("GET", "/api/documents"),
  createDocument: () =>
    request<{ document: DocumentDetail }>("POST", "/api/documents", { json: {} }).then((r) => r.document),
  importDocument: (file: File) => {
    const form = new FormData();
    form.append("file", file, file.name);
    return request<{ document: DocumentDetail }>("POST", "/api/documents/import", { form }).then((r) => r.document);
  },
  getDocument: (id: string) => request<{ document: DocumentDetail }>("GET", doc(id)).then((r) => r.document),
  renameDocument: (id: string, title: string) =>
    request<{ document: DocumentSummary }>("PATCH", doc(id), { json: { title } }).then((r) => r.document),
  saveContent: (id: string, content: string, baseRevision: number) =>
    request<SaveResult>("PUT", `${doc(id)}/content`, { json: { content, baseRevision } }),
  deleteDocument: (id: string) => request<void>("DELETE", doc(id)),

  listShares: (id: string) => request<{ shares: Share[] }>("GET", `${doc(id)}/shares`).then((r) => r.shares),
  upsertShare: (id: string, userId: string, role: ShareRole) =>
    request<{ share: Share }>("POST", `${doc(id)}/shares`, { json: { userId, role } }).then((r) => r.share),
  revokeShare: (id: string, userId: string) =>
    request<void>("DELETE", `${doc(id)}/shares/${encodeURIComponent(userId)}`),

  listVersions: (id: string) =>
    request<{ versions: VersionSummary[] }>("GET", `${doc(id)}/versions`).then((r) => r.versions),
  getVersion: (id: string, versionId: string) =>
    request<{ version: VersionDetail }>("GET", `${doc(id)}/versions/${encodeURIComponent(versionId)}`).then(
      (r) => r.version,
    ),
  restoreVersion: (id: string, versionId: string) =>
    request<RestoreResult>("POST", `${doc(id)}/versions/${encodeURIComponent(versionId)}/restore`),

  /** Fetches the Markdown export and returns it with the server-chosen filename. */
  exportMarkdown: async (id: string): Promise<{ blob: Blob; filename: string }> => {
    const res = await send("GET", `${doc(id)}/export`);
    try {
      return { blob: await res.blob(), filename: filenameFromDisposition(res.headers.get("Content-Disposition")) };
    } catch {
      throw new NetworkError("The download was interrupted. Please try again.");
    }
  },
};

/** Human-readable message for any thrown value. */
export function errorMessage(err: unknown, fallback = "Something went wrong. Please try again."): string {
  if (err instanceof ApiError || err instanceof NetworkError) return err.message;
  return fallback;
}
