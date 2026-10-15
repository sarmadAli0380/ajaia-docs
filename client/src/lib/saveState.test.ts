import { describe, expect, it } from "vitest";
import { ApiError, NetworkError } from "./api";
import { codePointLength, formatRelative, normalizeTitle } from "./format";
import { canSave, classifySaveError, initialSaveState, saveReducer, statusLabel, type SaveState } from "./saveState";

function run(state: SaveState, ...events: Parameters<typeof saveReducer>[1][]): SaveState {
  return events.reduce(saveReducer, state);
}

describe("save state machine", () => {
  const fresh = initialSaveState(3);

  it("starts saved and becomes unsaved on edit", () => {
    expect(statusLabel(fresh)).toBe("Saved");
    expect(canSave(fresh)).toBe(false);
    const edited = run(fresh, { type: "EDITED", dirty: true });
    expect(edited.status).toBe("unsaved");
    expect(canSave(edited)).toBe(true);
    // Undoing back to the saved content clears the dirty flag.
    expect(run(edited, { type: "EDITED", dirty: false }).status).toBe("saved");
  });

  it("saving -> saved advances the revision", () => {
    const s = run(fresh, { type: "EDITED", dirty: true }, { type: "SAVE_STARTED" });
    expect(s.status).toBe("saving");
    expect(canSave(s)).toBe(false); // EC-9: no double save while pending
    const done = saveReducer(s, { type: "SAVE_SUCCEEDED", revision: 4, dirty: false });
    expect(done).toMatchObject({ status: "saved", revision: 4, dirty: false });
  });

  it("typing during a save leaves the document unsaved afterwards", () => {
    const s = run(
      fresh,
      { type: "EDITED", dirty: true },
      { type: "SAVE_STARTED" },
      { type: "EDITED", dirty: true },
      { type: "SAVE_SUCCEEDED", revision: 4, dirty: true },
    );
    expect(s).toMatchObject({ status: "unsaved", dirty: true, revision: 4 });
  });

  it("network failure -> error with retry; content stays dirty (EC-8)", () => {
    const s = run(
      fresh,
      { type: "EDITED", dirty: true },
      { type: "SAVE_STARTED" },
      { type: "SAVE_FAILED", message: "offline", retryable: true },
    );
    expect(s).toMatchObject({ status: "error", dirty: true, retryable: true, revision: 3 });
    expect(statusLabel(s)).toBe("Error");
    expect(canSave(s)).toBe(true);
    // Further typing keeps the error visible.
    expect(saveReducer(s, { type: "EDITED", dirty: true }).status).toBe("error");
  });

  it("conflict blocks plain saves until resolved (EC-5)", () => {
    const s = run(
      fresh,
      { type: "EDITED", dirty: true },
      { type: "SAVE_STARTED" },
      { type: "SAVE_CONFLICT", message: "changed", currentRevision: 7 },
    );
    expect(s).toMatchObject({ status: "conflict", conflictRevision: 7, dirty: true });
    expect(canSave(s)).toBe(false);
    const reloaded = saveReducer(s, { type: "SYNCED", revision: 7 });
    expect(reloaded).toEqual(initialSaveState(7));
  });

  it("lost access keeps edits and blocks saving (EC-6)", () => {
    const s = run(fresh, { type: "EDITED", dirty: true }, { type: "SAVE_STARTED" }, { type: "ACCESS_LOST", message: "gone" });
    expect(s).toMatchObject({ status: "blocked", dirty: true });
    expect(canSave(s)).toBe(false);
    expect(saveReducer(s, { type: "EDITED", dirty: true }).status).toBe("blocked");
  });
});

describe("classifySaveError", () => {
  it.each([
    [new ApiError(409, "changed", { currentRevision: 9 }), "conflict"],
    [new ApiError(403, "nope", {}), "forbidden"],
    [new ApiError(404, "missing", {}), "gone"],
    [new ApiError(401, "login", {}), "unauthorized"],
    [new ApiError(413, "too large", {}), "fatal"],
    [new ApiError(400, "bad", {}), "fatal"],
    [new ApiError(500, "boom", {}), "retryable"],
    [new ApiError(503, "down", {}), "retryable"],
    [new NetworkError(), "retryable"],
    [new Error("weird"), "retryable"],
  ])("%s -> %s", (err, kind) => {
    expect(classifySaveError(err).kind).toBe(kind);
  });

  it("carries the server's current revision on conflict", () => {
    const failure = classifySaveError(new ApiError(409, "changed", { currentRevision: 9 }));
    expect(failure).toMatchObject({ kind: "conflict", currentRevision: 9 });
  });
});

describe("format helpers", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  it.each([
    ["2026-10-15T11:59:30Z", "just now"],
    ["2026-10-15T11:55:00Z", "5 min ago"],
    ["2026-10-15T09:00:00Z", "3 h ago"],
    ["2026-10-14T11:00:00Z", "yesterday"],
    ["2026-10-12T11:00:00Z", "3 days ago"],
    ["not a date", ""],
  ])("formatRelative(%s)", (iso, expected) => {
    expect(formatRelative(iso, now)).toBe(expected);
  });

  it("counts emoji as one character like the server", () => {
    expect(codePointLength("📝".repeat(200))).toBe(200);
    expect(normalizeTitle("  a \n b  ")).toBe("a b");
  });
});
