# Architecture

## Priorities

In order:

1. **Correct and safe data handling.** The server enforces access control on every endpoint. Saves can't
   silently overwrite each other. Stored HTML is sanitized.
2. **No lost work.** Users always know whether their text is saved. Failures (conflict, network, revoked
   access, expired session) keep the editor content and offer a way forward.
3. **Easy to review and run.** One process, one `npm ci`, no database server needed locally, and
   deterministic tests.
4. **Usable from a 360px phone to desktop.**

Real-time collaboration, comments and real authentication were cut deliberately (see Scope cuts).

## Shape of the system

```
Browser (React SPA, TipTap)
   │  fetch /api/*  (same origin, httpOnly cookie, X-Requested-With header on writes)
   ▼
Express app (server/app.ts)
   ├─ http/auth.ts       session cookie → user; CSRF header check
   ├─ routes/api.ts      thin adapter: parse params → call service → JSON
   ├─ services/*         ALL business rules (access, validation, revisions, sharing, versions, import/export, sanitize)
   ├─ http/errors.ts     single JSON error boundary
   └─ http/static.ts     production: serves dist/client + SPA fallback (dev: Vite middleware instead)
   ▼
Db interface (server/db) ── PGlite (local dir / in-memory in tests)  or  pg Pool (DATABASE_URL, Neon)
```

- `shared/limits.ts` holds the limits and enums. `shared/api.ts` holds the response types. The server
  services and the React client both import them, so limits and response shapes can't drift without a
  type error.
- Route handlers don't contain rules. A handler reads `req.params`/`req.body`, calls one service function
  with the authenticated user id, and serializes the result. Services throw a `DomainError` with a `kind`
  (`validation`, `forbidden`, `not_found`, `conflict`, `too_large`, …). The HTTP layer maps `kind` to a
  status code.

## Data model

| Table               | Columns (key ones)                                                                                         | Notes |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | ----- |
| `users`             | `id uuid PK`, `name`, `email UNIQUE`                                                                       | Seeded with Alice, Bob and Carol. Ids are stable. |
| `documents`         | `id uuid PK`, `owner_id → users ON DELETE CASCADE`, `title`, `content` (sanitized HTML), `revision int ≥ 1`, `created_at`, `updated_at` | `revision` drives optimistic concurrency. |
| `document_shares`   | `PK(document_id, user_id)`, `role ∈ {viewer, editor}`, timestamps                                          | The primary key makes re-sharing an upsert. FKs cascade. |
| `document_versions` | `id uuid PK`, `document_id → documents ON DELETE CASCADE`, `revision`, `content`, `source ∈ {save, import, restore}`, `restored_from_revision`, `created_by → users ON DELETE SET NULL`, `created_at`, `UNIQUE(document_id, revision)` | One snapshot per content revision. The 50 newest are kept. |

Content is stored as sanitized HTML, the editor's own serialization, so formatting round-trips exactly.

When versions are created:

- A blank new document has no versions, which gives the "No versions yet" empty state.
- An import records revision 1 as `import`.
- Each successful save records `save`. Each restore records `restore` along with the source revision.
- Retention is pruned in the same transaction as the insert.

Schema creation and seeding run on every boot in one transaction guarded by `pg_advisory_xact_lock`. They
use `CREATE TABLE IF NOT EXISTS` and `INSERT … ON CONFLICT DO NOTHING`. This makes boot idempotent and safe
when two instances start at the same time.

## Access model

There is one function: `authorizeDocument(q, userId, documentId, need)` in `server/services/access.ts`.
Every document and child-resource service calls it first, with `need` set to `read`, `edit` or `own`.

| Caller relationship | read | edit (save, rename, restore) | own (share, revoke, list shares, delete) |
| ------------------- | ---- | ---------------------------- | ---------------------------------------- |
| owner               | ✓    | ✓                            | ✓                                        |
| editor share        | ✓    | ✓                            | 403                                      |
| viewer share        | ✓    | 403                                          | 403                                      |
| no relationship     | 404  | 404                          | 404                                      |
| malformed / unknown id | 404 | 404                       | 404                                      |

- A user without access gets **404, never 403**, so the response doesn't reveal whether a document exists.
- Child lookups are always scoped by document: `WHERE document_id = $1 AND id = $2` for versions,
  `(document_id, user_id)` for shares. A version id from another document returns "not found" (no IDOR).
  This is covered by tests.
- The full role matrix (11 operations × 4 relationships) is in `server/test/access.test.ts`. Each denied
  case also asserts that nothing changed.
- All `/api/documents*` routes sit behind `requireUser` (401 first).

### Sessions and CSRF (mocked auth)

- The cookie `ajaia_session` holds `base64url(JSON{uid, iat}).HMAC-SHA256`. Its flags are `httpOnly`,
  `SameSite=Lax`, and `Secure` in production. `trust proxy` is enabled in production for Render's TLS
  proxy.
- Verification compares the canonical encoded signature in constant time. It rejects tampered, foreign-secret,
  future-dated and expired (more than 7 days old) tokens, and tokens for users that no longer exist.
- `SESSION_SECRET` is required in production and must be at least 32 characters. Otherwise the server
  refuses to start. Development uses a clearly labelled fallback.
- CSRF defence in depth: every state-changing request must carry `X-Requested-With: ajaia-docs`. Browsers
  can't add custom headers cross-origin without a CORS preflight, and this server never approves one. This
  sits on top of `SameSite=Lax`. Sign-in is protected too (login CSRF).

## Concurrency

A save sends `{content, baseRevision}`. The service runs one transaction containing:

```sql
UPDATE documents SET content = $3, revision = revision + 1, updated_at = now()
 WHERE id = $1 AND revision = $2
 RETURNING revision, updated_at;
-- 0 rows → 409 { currentRevision }    1 row → INSERT version + prune, COMMIT
```

The check and the write are one statement. There is no read-then-write window, which the impact analysis
flagged as a lost-update risk. On Postgres at READ COMMITTED, a second concurrent UPDATE waits on the row
lock. It then re-evaluates `revision = $2` against the committed row, matches nothing, and gets a 409. On
PGlite, transactions are serialized, so the outcome is the same.

The tests assert exactly one 200 and one 409 for 2 concurrent saves, and 1 winner out of 8, with exactly one
version row each time.

Limitation: CI only runs PGlite. The Postgres argument above relies on documented Postgres semantics; it has
not been tested against Neon.

Related decisions:

- **Rename doesn't bump `revision`.** The title is separate metadata (last write wins). If renames bumped
  the revision, one user renaming would turn another user's in-progress save into a false conflict.
- **Restore is not conditional.** Restoring is an explicit choice and always creates a new revision and
  snapshot. The overwritten content stays in history if it was ever saved. The UI asks for confirmation,
  and warns about unsaved edits (EC-17).
- **"Keep my copy"** in the conflict dialog fetches the newest revision and saves on top of it. This is
  the only way to overwrite, and it needs an explicit click. Another race simply produces another 409.

## Sanitization and XSS

- One allowlist (`server/services/sanitize.ts`, sanitize-html) mirrors what the editor schema can
  represent: `p br strong b em i u s strike h1–h3 ul ol li blockquote pre code hr a[href]`. The editor
  includes TipTap's Link mark (http/https/mailto/relative only, no `target`, same `rel`), so imported links
  survive editing. A parity test (`client/src/lib/editorSanitizerParity.test.ts`) renders every node and
  mark of the editor schema and asserts the sanitizer leaves it unchanged, and that sanitized links
  survive a round-trip through the editor. `h4–h6` become
  `h3`. Script-like containers (`script style iframe svg math object embed template noscript textarea`)
  are dropped together with their contents. URL schemes are limited to `http`, `https` and `mailto`; there
  are no protocol-relative URLs, and `rel="noopener noreferrer nofollow"` is forced on links. NUL bytes
  and lone surrogates are normalized so Postgres never rejects the text.
- It runs on **every write path**: save, import (after conversion), and restore. Restore re-sanitizes old
  snapshots, so a tighter allowlist applies retroactively. Tests run an XSS corpus through the save path,
  the stored versions, and Markdown/DOCX import.
- Rendering never uses `innerHTML`. The editor and the version preview both load HTML through TipTap's
  schema, which drops unknown nodes and attributes. Titles, filenames and user names are React text nodes.
- The production SPA response sends a CSP: `script-src 'self'`, `object-src 'none'`,
  `frame-ancestors 'none'`, and so on. `style-src` allows `'unsafe-inline'` because TipTap/ProseMirror
  inject their own styles.

## Import and export

- Uploads use multer with memory storage. Limits: `fileSize` 2 MB (enforced while streaming, giving 413),
  one file, few fields. Authentication runs **before** the body is parsed, so anonymous uploads are never
  buffered. Filenames are decoded as UTF-8.
- Validation order: missing file (400), extension (415), empty (400), size (413), conversion, then the 1 MB
  content limit on the sanitized HTML (413).
- DOCX files are checked for the ZIP magic number first. The central directory is then walked the way
  JSZip (mammoth's ZIP reader) walks it: record after record while the signature matches, not just up to
  the declared count. The walk must agree exactly with the end-of-central-directory record (same count,
  directory ending exactly at the end record, no gap or prepended bytes) and names must be unique, or the
  upload is rejected with `400`. That guarantees the budget below covers every entry the parser can see.
  The directory is read *without decompressing*, and the file is rejected if it declares more than 32 MB uncompressed, more than 2000
  entries, or ZIP64 (cheap pre-check). Declared sizes are uploader-controlled and can lie, so before
  mammoth runs every entry is actually inflated with `zlib.inflateRawSync({ maxOutputLength })` and the
  output discarded; once the cumulative *real* decompressed size passes 32 MB the upload is rejected with
  `413` ("expands to too much data"). No inflate can allocate more than the remaining budget. Unknown
  compression methods, encrypted entries and corrupt streams return `400`. Mammoth runs with `externalFileAccess: false`; images are dropped and underline is kept.
- Text decoding: UTF-8 BOM, UTF-16 LE/BE BOMs, strict UTF-8, and otherwise Windows-1252 via an explicit
  table. Node's `TextDecoder("windows-1252")` turned out to decode as Latin-1 in our runtime; a test caught it.
- Export converts the HTML with turndown (ATX headings, `-` bullets, `*`/`**` emphasis). The filename is
  sanitized from the title and sent as an ASCII fallback plus an RFC 5987 `filename*`. It falls back to
  `document.md`, and header injection isn't possible.

## Errors

`http/errors.ts` is the only error boundary:

- `DomainError` maps to its status.
- Body-parser errors give 400 for malformed JSON and 413 for oversized bodies.
- Multer errors give 413 or 400.
- Any other exposed 4xx gets a generic message.
- Everything else is logged server-side and returns `500 {"error":"Something went wrong on our side. Please try again."}`
  with no stack trace or internal message.
- Unknown `/api/*` routes return a JSON 404 and are never swallowed by the SPA fallback.

## Client

- React 18, react-router 6 (data router, so `useBlocker` works for the in-app leave guard), and TipTap 2
  (StarterKit with H1–H3, plus Underline).
- `client/src/lib/saveState.ts` is a pure reducer for `saved / unsaved / saving / error / conflict / blocked`
  plus `classifySaveError`. It is unit-tested. `EditorPage` wires it to the API.
- A global `401` event clears the session and `RequireAuth` redirects to `/login`. The editor unmounts
  first, so its leave guard doesn't block a forced sign-out.
- All confirmations (delete, restore, leave, conflict) are in-app dialogs. `window.confirm` is never used.
  The only native prompt is the browser's `beforeunload` warning, which no page can replace.

### Responsive approach

The CSS is mobile-first with breakpoints at 600px and 1024px (see README). Layout rules use
`min-width: 0`, `overflow-wrap: anywhere` and `text-overflow: ellipsis` so long titles and words can't
force horizontal scrolling.

- The toolbar scrolls horizontally on phones and wraps from tablet up.
- Dialogs are full-screen on phones.
- Secondary editor actions move into an overflow menu below 1024px.
- Dashboard rows become cards below 1024px.

These were checked with headless Chrome at 360/768/1280 (document `scrollWidth` vs viewport, and target
sizes). That script is not committed; the next step is a Playwright suite.

## Tradeoffs and scope cuts

| Decision | Why | Cost |
| --- | --- | --- |
| Explicit save plus optimistic locking, not real-time co-editing | Far simpler and testable within the timebox; nothing is ever silently overwritten | Two people editing at once get a conflict dialog instead of merged edits |
| Store HTML, not ProseMirror JSON | Matches the import/export converters and the sanitizer; easy to inspect | The server can't validate structure beyond the allowlist |
| PGlite locally and in tests, Postgres in production | Zero-setup local runs and isolated in-memory tests with the real Postgres dialect | The pooled-connection path isn't covered by CI |
| Mocked auth with seeded users | Spec choice; lets reviewers switch users instantly | Not real security. `/api/users` is public |
| Hand-written schema bootstrap, no migration tool | Four tables, idempotent DDL | Future schema changes need a migration runner |
| Version snapshots are full copies, capped at 50 | Simple restore and preview | Storage grows with document size × 50 |
| No autosave | The spec asks for explicit save, Ctrl/Cmd+S, and clear save states | Users must save (they are warned before leaving) |

Left out entirely: comments and suggestions, real-time presence, real auth and sign-up, images, tables and
attachments, PDF/DOCX export, and performing the deployment.

## Known gaps and next steps (2–4 hours)

1. Playwright E2E tests for the UI-only edge cases and responsive overflow, and CI with a Postgres service
   container, so the `pg` path and true parallel saves run against a real server.
2. Autosave drafts to `sessionStorage` so unsaved text survives a forced re-login.
3. A versioned migration runner.
4. Rate limiting (sign-in, import, save) and structured logs with request ids.
5. Optional: store ProseMirror JSON next to the HTML for structural validation, and use diff-based version
   storage.
