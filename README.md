# Ajaia Docs

A lightweight, Google-Docs-inspired document editor. You can create and edit rich-text documents, import
`.txt` / `.md` / `.docx` files, share documents with other users as viewer or editor, browse and restore
version history, and export to Markdown. One Node.js process serves both the REST API and the React app.
Data is stored in Postgres (Neon in production), or in an embedded PGlite database locally.

- **Live app:** `TODO: add the Render URL after deploying` (see [Deploying](#deploying-render--neon))
- **Walkthrough video:** see [`VIDEO_URL.txt`](VIDEO_URL.txt)
- Design and tradeoffs: [`ARCHITECTURE.md`](ARCHITECTURE.md). How AI was used: [`AI_WORKFLOW.md`](AI_WORKFLOW.md).
  What's included in the submission: [`SUBMISSION.md`](SUBMISSION.md).

## Seeded users (mocked sign-in)

Authentication is deliberately mocked. The login screen lists three seeded users and you pick one. There is
no password. The choice is stored in a signed, httpOnly session cookie that lasts 7 days.

| Name  | Email              | User id                                |
| ----- | ------------------ | -------------------------------------- |
| Alice | `alice@ajaia.test` | `a11ce000-0000-4000-8000-000000000001` |
| Bob   | `bob@ajaia.test`   | `b0b00000-0000-4000-8000-000000000002` |
| Carol | `carol@ajaia.test` | `ca401000-0000-4000-8000-000000000003` |

To try sharing, sign in as Alice, create a document and share it with Bob. Then sign out, sign in as Bob, and
open it from **Shared with me**. A private window works too.

## Features

- Rich-text editing with TipTap: bold, italic, underline, H1/H2/H3, bulleted and numbered lists, undo/redo.
  Toolbar buttons show which formatting is active.
- Explicit save with the **Save** button or **Ctrl/Cmd+S**. The status shows *Saved*, *Unsaved changes*,
  *Saving…*, *Error* (with Retry), *Conflict* or *Not saved* (access lost). You are warned before leaving
  with unsaved changes.
- Inline rename. Owners and editors can rename. Titles are trimmed and must be 1–200 characters.
- Import of `.txt`, `.md` and `.docx` (up to 2 MB). Each import becomes a new document owned by the uploader
  and is titled from the filename.
- Sharing. The owner can grant viewer or editor access, change a role, or revoke access. The dashboard
  splits documents into **My documents** and **Shared with me**.
- Version history. Every successful save records a snapshot. You can list, preview and restore versions;
  the 50 most recent are kept per document.
- Export to Markdown (`.md` download).
- Optimistic concurrency. A save based on an old revision is rejected with `409`. You then choose
  *Reload latest*, *Keep my copy* (overwrite) or *Copy my text*.
- Server-side HTML sanitization on every write path (save, import, restore).

## Running locally

Requirements: Node.js 20 or newer, and npm. No database server is needed.

```bash
npm ci            # install dependencies (exactly as locked)
npm run dev       # API + Vite dev server with HMR on http://localhost:3000
```

Local data is stored in `.data/pglite` (git-ignored). Delete that folder to reset everything.

| Script              | What it does                                                                        |
| ------------------- | ----------------------------------------------------------------------------------- |
| `npm run dev`       | Starts the server with Vite middleware (one port, hot reload) using `tsx watch`.    |
| `npm run build`     | Builds the client into `dist/client` and compiles the server into `dist/node`.      |
| `npm start`         | Runs the compiled production server, which serves the API and the built SPA.        |
| `npm test`          | Runs all tests once with Vitest. API tests use an in-memory PGlite per test file.   |
| `npm run typecheck` | Runs `tsc --noEmit` for the server/tests (NodeNext) and the client (DOM/JSX).       |

To try a production build locally:

```bash
npm run build
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
NODE_ENV=production PORT=3000 npm start
```

### Environment variables

The app reads these from the environment. It does not load `.env` files.

| Variable         | Default        | Notes                                                                                        |
| ---------------- | -------------- | -------------------------------------------------------------------------------------------- |
| `DATABASE_URL`   | *(unset)*      | Postgres connection string. If set, Postgres is used (TLS on unless the host is local or `sslmode=disable`). |
| `PGLITE_DIR`     | `.data/pglite` | PGlite data directory, used when `DATABASE_URL` is unset.                                     |
| `SESSION_SECRET` | dev fallback   | **Required in production (32+ characters)**. The server refuses to start without it.          |
| `PORT`           | `3000`         | HTTP port.                                                                                    |
| `NODE_ENV`       | *(unset)*      | `production` enables Secure cookies, `trust proxy`, and the required-secret check.           |

## Tests

```bash
npm test
```

The API integration tests use Vitest and supertest against `createApp()` with a fresh in-memory PGlite
database per test file. They cover:

- auth and the 401 matrix
- the role matrix for every document endpoint
- sharing rules
- import per file type (DOCX fixtures are generated in the test)
- export
- versions and retention
- sanitization, against an XSS payload corpus on every write path
- optimistic concurrency, including concurrent saves
- generic 500 handling
- persistence across a restart, using a temporary PGlite directory

Client save-state logic is unit-tested in `client/src/lib/saveState.test.ts`. The tests need no network, no
environment variables and no pre-existing data.

## Supported uploads and limits

| Type    | Extension | How it's converted                                                                                       |
| ------- | --------- | -------------------------------------------------------------------------------------------------------- |
| Text    | `.txt`    | Blank lines become paragraphs and single newlines become line breaks. UTF-8 (with or without a BOM), UTF-16 with a BOM, and Windows-1252 are decoded. |
| Markdown| `.md`     | `marked` (GFM). Headings, lists and emphasis are kept; `####`–`######` become H3.                         |
| Word    | `.docx`   | `mammoth`. Headings, bold, italic, underline, lists and http/https/mailto links are kept; images are dropped. |

- Maximum upload: **2 MB** (`413` if larger). An empty file returns `400`. An unsupported extension returns
  `415`. A file that isn't a valid DOCX returns `400` ("Could not read file"). A `.docx` that really
  decompresses to more than 32 MB (whatever sizes it declares) returns `413`.
- The converted document must also fit the **1 MB** stored-content limit. Very large plain-text files can be
  valid uploads but still be rejected with `413`.
- The title comes from the filename: path segments and the extension are removed, control characters and
  extra whitespace are collapsed, and it is cut to 200 characters. If nothing is left, it falls back to
  "Untitled document".

## Deploying (Render + Neon)

Deployment is not automated from this repo. These are the steps the owner runs:

1. **Neon:** create a project and database. Copy the pooled connection string
   (`postgresql://…?sslmode=require`).
2. **Render:** go to *New → Blueprint* and pick this repository. Render reads [`render.yaml`](render.yaml):
   - build: `npm ci --include=dev && npm run build` (dev dependencies are needed to build)
   - start: `npm start`
   - health check: `GET /api/health`
   - `NODE_ENV=production`, `NODE_VERSION=22`, `SESSION_SECRET` (generated by Render), and `DATABASE_URL`
     (`sync: false`, so it is not stored in the repo)
3. Paste the Neon connection string into the service's `DATABASE_URL` and deploy. Tables and the three
   seeded users are created on first boot. This step is idempotent and safe on every restart.
4. Open the service URL, sign in as Alice, and add the URL to this README and `SUBMISSION.md`.

Without `DATABASE_URL`, production falls back to PGlite on the instance disk, which Render's free tier
wipes on every deploy or restart. Always set `DATABASE_URL` in production.

## Responsive design

The layout is mobile-first, with breakpoints at **600px** and **1024px**. It was checked at 360×740,
768×1024 and 1280×800 in headless Chrome: no page-level horizontal scroll on the login, dashboard, editor,
viewer, share, history or import screens.

| Width       | Layout                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `< 600px`   | Documents show as single-column cards. Header buttons collapse to icons. Share, History and Export move into a "⋯" menu. The toolbar stays on one line and scrolls sideways. Touch targets are 44px. Dialogs are full-screen; confirmations are bottom sheets. The history list and preview show one at a time. |
| `600–1023px`| Documents show as two-column cards. The toolbar wraps. Secondary editor actions stay in the "⋯" menu. Dialogs are centred (max 580/960px). Touch targets are 40px. The history list and preview sit side by side. |
| `≥ 1024px`  | Documents show as a table with Title, Owner, Access and Last updated columns. Share, Version history and Export appear inline. The page is a 816px "paper" column.                       |

Long titles are cut off with an ellipsis everywhere. Long unbroken words wrap inside the editor. Code blocks
wrap or scroll inside their own box. Touch devices (`pointer: coarse`) always get 44px targets.

## Edge-case catalogue

"Automated" means covered by `npm test`. "Manual" means checked by hand in a browser. During
implementation, every manual row was also exercised by a throwaway headless-Chrome script, which is not part
of the repo.

| ID    | Behaviour                                                                                                     | Where it's handled                                                    | Verification |
| ----- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------ |
| EC-1  | Whitespace-only, >200 characters, missing or non-string titles return `400` with a message. Unicode and emoji are accepted (an emoji counts as 1 character). HTML in titles is stored as-is and shown as text. | `services/text.ts` `parseTitle`; React renders titles as text only | Automated: `documents.test.ts`. Manual: an HTML title shows literally on the dashboard |
| EC-2  | Malformed JSON, non-object bodies or wrong field types return a `400` JSON error, never `500`.                  | `http/errors.ts`, `services/input.ts`                                  | Automated: `documents.test.ts` |
| EC-3  | A non-UUID or nonexistent document id returns `404` on every document endpoint.                               | `services/access.ts` `authorizeDocument`                               | Automated: `documents.test.ts` |
| EC-4  | Content over 1 MB (UTF-8 bytes) returns `413` with a message. An empty document saves fine.                    | `services/documents.ts` `prepareContent`                               | Automated: `documents.test.ts` |
| EC-5  | A stale save returns `409` with `currentRevision`. The UI offers *Reload latest*, *Keep my copy* (an explicit overwrite) or *Copy my text*. | `saveContent` (conditional UPDATE); `EditorPage` conflict dialog | Automated: API + `saveState.test.ts`. Manual: conflict dialog |
| EC-6  | If access is revoked or the document is deleted while open, the next save or rename shows a clear message with "Copy my text" and "Back to documents". Editor content is kept. | `authorizeDocument` (404/403); `EditorPage` lost-access banner | Automated: `sharing.test.ts`, `documents.test.ts`. Manual: banner |
| EC-7  | A missing or expired session makes any `401` send the user to the login screen ("Your session ended").          | `http/auth.ts`; `lib/api.ts` event → `auth.tsx` → `RequireAuth`         | Automated: `auth.test.ts` (tampered, expired, foreign-secret cookies). Manual: redirect |
| EC-8  | A network failure on save shows *Error* with **Retry**. Unsaved content stays in the editor.               | `lib/saveState.ts`, `EditorPage`                                       | Automated: `saveState.test.ts`. Manual: offline save, then Retry |
| EC-9  | Double-clicking Create, Save, Import, Share, Delete or Restore doesn't create duplicates; buttons are disabled while a request is pending. | Pending flags in every dialog/page; `canSave` | Automated: `saveState.test.ts`. Manual: a triple-clicked Save gives one version |
| EC-10 | Sharing with yourself, the owner (in any letter case of the id), an unknown user, or an invalid role returns `400`. Re-sharing updates the role (upsert) instead of duplicating. | `services/sharing.ts` `upsertShare` | Automated: `sharing.test.ts` |
| EC-11 | A non-owner sharing, revoking, listing shares or deleting gets `403` (viewer/editor) or `404` (no access).        | `authorizeDocument(..., "own")`                                        | Automated: `sharing.test.ts`, `access.test.ts` |
| EC-12 | Empty upload: `400`. Unsupported extension: `415`. Over 2 MB: `413`. `.docx` whose real decompressed size exceeds 32 MB (even if it declares less): `413`. `.docx` whose central directory disagrees with its end record (hidden extra records, size/offset gaps, duplicate entry names): `400`. Fake `.docx`: `400` "Could not read file". Missing, extra or misnamed file field: `400`. | `services/importer.ts`, multer limits, `http/errors.ts` | Automated: `import.test.ts` |
| EC-13 | BOM-prefixed, UTF-16 and Windows-1252 `.txt` files import cleanly. Blank lines become paragraphs. NUL bytes are removed. | `importer.ts` `decodeText` / `textToHtml` | Automated: `import.test.ts` |
| EC-14 | Scripts, event handlers and `javascript:`/`data:` links in Markdown or DOCX are removed on import.             | `services/sanitize.ts` (shared allowlist)                              | Automated: `import.test.ts`, `sanitize.test.ts` |
| EC-15 | Upload filenames with path segments, special characters or more than 200 characters give a safe, trimmed title. | `importer.ts` `titleFromFilename`                                     | Automated: `import.test.ts` |
| EC-16 | A viewer pressing Ctrl/Cmd+S or typing changes nothing and sees a "view-only" explanation. There is no toolbar or Save button. | `EditorPage` (`explainReadOnly`, read-only editor) | Manual: Ctrl+S toast, read-only banner |
| EC-17 | Restoring a version with unsaved edits asks for confirmation inside the app ("Discard changes and restore").    | `HistoryDialog` inline confirmation                                    | Manual: restore with unsaved edits |
| EC-18 | The export filename is built from a sanitized title (no quotes, slashes or control characters; UTF-8 `filename*`). The fallback is `document.md`. | `services/exporter.ts` `contentDisposition` | Automated: `export.test.ts` |
| EC-19 | Leaving with unsaved changes warns you: in-app links and back/forward use an in-app dialog (Stay / Save and leave / Leave); closing or reloading uses the browser's `beforeunload` prompt. | `EditorPage` (`useBlocker`, `beforeunload`) | Manual: back link opens the dialog; reload prompts |
| EC-20 | Empty states appear for no owned documents, no shared documents, no versions and no other users to share with. | `DashboardPage`, `HistoryDialog`, `ShareDialog`                        | Manual (API side of "no versions" automated in `versions.test.ts`) |
| EC-21 | Unexpected server errors return a generic JSON message with no stack trace, and are logged on the server.      | `http/errors.ts` `errorHandler`                                        | Automated: `errors.test.ts` |
| EC-22 | Deleting a document needs in-app confirmation and removes its shares and versions (`ON DELETE CASCADE`).        | `DashboardPage` confirm dialog; `deleteDocument`; schema FKs            | Automated: `documents.test.ts`. Manual: confirm dialog |

## Project layout

```
shared/            limits + API response types used by both server and client
server/
  app.ts           createApp(): Express app (used by tests and the entry points)
  index.ts         production entry (serves dist/client); dev.ts = dev entry (Vite middleware)
  config.ts        env parsing, fail-fast SESSION_SECRET in production
  db/              Db interface (PGlite | pg Pool), idempotent schema + seed
  http/            session cookie + CSRF guard, JSON error boundary, static SPA serving
  routes/api.ts    thin REST adapter
  services/        all business rules: access, documents, sharing, versions, import, export, sanitize
  test/            Vitest + supertest integration tests
client/            Vite + React SPA (pages, components, lib/saveState.ts state machine)
render.yaml        Render blueprint
```

## Status

**Working:** everything listed under Features, plus the edge cases above, across 360px phones to desktop.

**Incomplete / known limitations**

- No real-time co-editing or presence. Concurrent edits are detected on save (409), not merged.
- Authentication is mocked (no passwords). `/api/users` is public so the login screen can list users.
- The Postgres (Neon) code path is not exercised by CI. The tests run against PGlite, which is the same
  Postgres SQL dialect but a single connection. See ARCHITECTURE.md → Concurrency.
- There are no automated browser (E2E) tests in the repo. UI-only edge cases are listed above as manual
  checks.
- Export produces Markdown only. Underline has no Markdown equivalent and is exported as plain text.
- There is no rate limiting, and no migration framework (the schema uses `CREATE … IF NOT EXISTS`).

**Next 2–4 hours**

1. Add Playwright E2E tests for the manual rows above (conflict dialog, leave guard, viewer, responsive
   overflow at 360/768/1280), and run CI against a Postgres service container.
2. Autosave drafts to `sessionStorage`, so an expired session (EC-7) can't lose unsaved text.
3. Add a small migration runner (versioned SQL files) before the schema changes again.
4. Basic rate limiting on sign-in, import and save, plus structured request logging.
