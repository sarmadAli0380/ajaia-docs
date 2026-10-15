# AI workflow

This project was built with AI assistance under human direction. This file records which tools were used,
where they helped, what was changed or rejected along the way, and how the result was verified.

## Tools

- **Claude Code (Opus)** as the orchestrator. It ran "autopilot", a spec-first pipeline the author designed and built as a Claude Code skill, with separate
  sub-agents, each with a narrow role:
  - **Impact analyst.** Read the repository and the approved spec, then produced an impact report:
    affected consumers, regression flows, risks rated HIGH/MEDIUM/LOW, and unknowns.
  - **Implementer.** Wrote the code, tests and docs in an isolated git worktree, using only the approved
    spec and impact report as authority. It was not allowed to commit, push or deploy.
  - **Independent code/security reviewer.** Reviews the diff cold, without seeing the implementer's
    explanation.
  - **Independent QA validator.** Runs the gates and checks the acceptance criteria and edge cases
    independently.
- **Gates.** `npm ci && npm run build`, `npm ci && npm run typecheck`, and `npm ci && npm test`, run from a
  clean checkout. A baseline was captured on the starting commit before any change.

The human set the stack (Express + React/Vite + TipTap, Postgres/Neon with a PGlite fallback, Render) and
approved the spec before any code was written.

## Where AI sped things up

- **Spec and edge-case enumeration.** It turned a one-paragraph brief into 17 acceptance criteria and a
  22-item edge-case catalogue, each mapped to automated tests or manual checks.
- **Risk analysis before coding.** The impact report pointed at the riskiest areas (concurrency, XSS,
  authorization consistency, upload parsing, gate fragility) before any code existed.
- **Boilerplate-heavy parts.** Express wiring, the role-matrix tests, the generated DOCX fixtures (a small
  ZIP writer in the test helpers), the responsive CSS, and the docs.
- **Fast feedback loops.** The implementer ran typecheck, tests, a production build and a production
  smoke run repeatedly. It also drove headless Chrome to measure horizontal overflow and touch targets at
  360/768/1280px and to step through the editor's edge-case flows.

## Changes, corrections and rejections

These are the real course corrections made during the run.

1. **Gate configuration rejected by the orchestrator.** The auto-generated gate config had two problems.
   The gates never installed dependencies, and the typecheck was modelled as a "delta" gate (compare
   against baseline errors), which makes no sense on a base that already type-checks cleanly. The
   orchestrator rejected it. The corrected gates run `npm ci` first and treat typecheck as an absolute
   pass/fail.
2. **First spec draft rejected by the user.** The user required responsive behaviour (360px phones
   through desktop) and an explicit, numbered 22-item edge-case catalogue (EC-1…EC-22). Both became
   acceptance criteria (AC-RESPONSIVE, AC-EDGE).
3. **Save race found by impact analysis.** The analyst flagged that a "read revision, then write" save
   allows two concurrent saves to both succeed (a lost update). The implementation uses a single
   conditional `UPDATE … WHERE id = $1 AND revision = $2` plus the version insert in one transaction.
   Tests assert exactly one winner under concurrent saves.
4. **Dependency pinned for Node 20.** The newest `sanitize-html` (2.17.6+ / 2.18) declares
   `node >= 22.12`, which conflicts with the required `node >= 20`. The implementer pinned it to exactly
   `2.17.5`, the newest release without that floor.
5. **Windows-1252 decoding bug caught by a test.** `TextDecoder("windows-1252")` in the Node runtime
   decoded bytes 0x80–0x9F as Latin-1 control characters, so curly quotes came out wrong. It was
   replaced with an explicit Windows-1252 table, and the test now checks “ ” – €.
6. **SPA fallback bug found in the production smoke run.** With the app installed under a path containing
   a dot-directory, `res.sendFile(absolutePath)` refused to serve `index.html`, treating it as a dotfile.
   It was fixed by using `sendFile("index.html", { root })`, and a regression test now serves the SPA from
   a hidden directory.
7. **A flaky test exposed a signature-malleability nit.** A tamper test that replaced the last two
   base64url characters occasionally passed verification, because the final character carries ignored
   bits. Verification now compares the canonical encoded signature, and the test tampers
   deterministically. There is also a test that a non-canonical encoding is rejected.
8. **Wrong test expectations corrected, not the code.** Two first-draft assertions were wrong: a filename
   containing `/` is a path, and a file literally named `.md` is a valid Markdown upload. The tests were
   changed to match the intended, documented behaviour.
9. **Responsive check found small targets.** On phones the icon-only header buttons were 32–35px wide.
   They now have a 44px minimum.
10. **Independent review (round 1) found four defects; all fixed with regression tests.** The independent
    code/security reviewer proved the implementer's declared-size zip-bomb guard was bypassable: a lying
    archive (declared tiny, really inflating to hundreds of MB) passed the check and drove the DOCX parser
    to ~517 MB of memory. The importer now inflates every entry under a hard `maxOutputLength` budget
    before mammoth runs. The reviewer also found an owner self-share via an upper-cased owner UUID (the
    check compared the raw request string; it now compares the canonical id from the database) and a
    link schema mismatch (the sanitizer kept `<a href>` but the editor had no Link mark, so imported
    links vanished on first save; the Link extension was added plus an editor/sanitizer parity test). QA
    found a modal focus-loss bug: clicking a version row disabled the focused button, focus fell to
    `<body>`, and Escape/Tab stopped working in the dialog. The modal now traps keys at document level and
    the clicked controls use `aria-disabled` so they keep focus.
    **Round 2 caught that the first zip fix was incomplete.** A fresh reviewer read JSZip's source and
    found it keeps reading central-directory records past the declared count, so a hidden extra record
    (a 66 KB upload inflating to 67 MB) was decompressed by mammoth but never budgeted. The guard now walks
    the directory exactly as JSZip does and rejects any archive where that walk disagrees with the end
    record. Two of the four new tests (the hidden extra record and duplicate entry names) were run against the previous code and fail there; the other two (directory gap and size mismatch) are additional hardening that the earlier code already happened to reject. Lesson: a
    security check must validate the same view of the input that the parser will consume.
11. **Scope held.** Real-time co-editing, comments, real auth and PDF export stayed out of scope, as the
    approved spec says.

## How it was verified

- **Gates:** build, typecheck (server and client, zero errors) and tests all pass from `npm ci`.
- **Automated tests:** API integration tests (supertest against `createApp` with in-memory PGlite) for
  every API-observable edge case, plus the role matrix, import per file type, export, versions,
  sanitization corpus, concurrency, and persistence across a restart. Client save-state logic has unit
  tests.
- **Production smoke run:** `npm run build && npm start` on a spare port with a temporary PGlite directory.
  Checked `/api/health`, the SPA index, deep-link fallback, JSON 404 for unknown API paths, immutable
  asset caching, and the cookie flags (`HttpOnly; Secure; SameSite=Lax`).
- **Manual and scripted UI checks:** headless Chrome at 360×740, 768×1024 and 1280×800 confirmed no
  horizontal page scroll on the login, dashboard, editor, viewer, share, history and import screens, and
  full-screen dialogs on phones. A scripted pass covered Ctrl+S, toolbar active state, the leave guard,
  the 409 conflict dialog (reload and keep-mine), restore with unsaved edits, offline save then Retry, a
  triple-clicked Save producing one version, a revoked editor, viewer Ctrl+S, the delete confirmation, an
  HTML title rendered as text, empty states, and 401 redirecting to login. These scripts were throwaway
  and are not committed; turning them into a Playwright suite is the top next step.
- **Independent validation:** a separate code/security reviewer and a separate QA validator review the
  change cold. The implementer's self-checks don't replace them.

## Author's notes

How I steered the AI during this build:

- Designed the delivery pipeline myself (a Claude Code skill I wrote, called "autopilot"). I built it because AI writes code fast but over-trusts its own output. Its rules: a human signs off the spec before any code; building and verifying are done by separate agents in isolated git worktrees; validators never see the implementer's explanations; only hashed command output counts as evidence, not an agent's "PASS"; repair rounds are capped at three; and nothing is committed unless the exact reviewed tree passes a deterministic gate. On this project it caught a zip-bomb guard that was bypassable twice, which a single self-grading agent had marked as done.
- Set the product scope before any code. I chose Render + Neon so persistence would survive restarts on free tiers, seeded users with mocked sign-in so reviewers can test sharing in seconds, import-as-a-new-document as the upload flow, and Viewer/Editor roles, version history and Markdown export as stretch. I left out autosave.
- Rejected the first spec. The AI's draft covered the features but not robustness, so I made it add a responsive UI (360 to 1280 px) and an explicit 22-item edge-case catalogue, each with a defined behaviour, before anything was built.
- Challenged the role split. When the implementer agent was "checking responsiveness", I asked why the builder was verifying its own work rather than QA. As a result, responsive behaviour is proven by independent Playwright runs at three viewports, with screenshots, and the builder's self-checks count for nothing.
- Managed the timebox actively. I kept feeding the AI my remaining minutes, which forced a plan with hard cutoffs, a cap on repair rounds, and deployment set up in parallel with the final validation round instead of after it.
- Chose to delete an AI-generated .env.example that a safety guard had blocked, rather than let the AI work around the guard.
- Refused to ship a known overclaim. When the final reviewer found one inaccurate sentence in the AI-written workflow note, I chose to correct it and disclose that the shipped tree differs from the validated one only by that sentence, rather than ship it as-is.
- Kept the write-up anchored to the brief. I made the AI rebuild this submission from the original instructions, section by section, and I narrate the walkthrough video in my own voice rather than using text-to-speech, because communication is part of what is being assessed.
