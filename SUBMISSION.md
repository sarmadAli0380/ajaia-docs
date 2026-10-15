# Submission: Ajaia Docs

- **Live app:** https://ajaia-docs-tt4n.onrender.com
- **Walkthrough video:** https://www.loom.com/share/21d51be3254942b98983d1093c2aaf1d (also in [`VIDEO_URL.txt`](VIDEO_URL.txt))

## Seeded accounts (mocked sign-in: pick a user, no password)

| Name  | Email              |
| ----- | ------------------ |
| Alice | `alice@ajaia.test` |
| Bob   | `bob@ajaia.test`   |
| Carol | `carol@ajaia.test` |

## Included

**Application**

- `server/`: Express REST API. Business rules live in `server/services/`. Persistence is in `server/db/`
  (Postgres via `DATABASE_URL`, otherwise PGlite). There is a session/CSRF layer, a JSON error boundary,
  and static SPA serving.
- `client/`: Vite + React SPA with the TipTap editor, dashboard, sharing, version history, import dialog
  and a responsive stylesheet.
- `shared/`: limits and API response types shared by the server and client.

**Tests**

- `server/test/*.test.ts`: API integration tests covering auth, the role matrix, documents (save,
  concurrency, limits, delete), sharing, import (txt/md/docx and EC-12…EC-15), versions, export,
  sanitization, error handling and persistence across a restart.
- `client/src/lib/saveState.test.ts`: unit tests for the editor's save-state machine.
- `src/smoke.test.ts`: the original toolchain smoke test.

**Configuration**

- `package.json` and `package-lock.json`, with the scripts `dev`, `build`, `start`, `typecheck` and `test`.
- `tsconfig.json` (server and tests), `tsconfig.build.json` (server emit), `client/tsconfig.json` (client),
  `vite.config.ts` and `vitest.config.ts`.
- `render.yaml`: Render blueprint (build, start, health check, `DATABASE_URL`, generated `SESSION_SECRET`).

**Documentation**

- `README.md`: setup, run, test and deploy steps, seeded users, upload types and limits, environment
  variables, the edge-case catalogue, responsive breakpoints, and status (working, incomplete, next).
- `ARCHITECTURE.md`: priorities, data model, access model, concurrency, sanitization, tradeoffs, scope cuts
  and next steps.
- `AI_WORKFLOW.md`: the tools and pipeline used, course corrections, and verification. It ends with the
  author's notes on how the AI was steered.
- `SUBMISSION.md`: this file.
- `VIDEO_URL.txt`: placeholder for the video link.

## How to run

```bash
npm ci && npm run dev     # http://localhost:3000
npm test                  # all tests
```

## Repository

- Source: https://github.com/sarmadAli0380/ajaia-docs (branch `main`), deployed to Render with Neon Postgres.
