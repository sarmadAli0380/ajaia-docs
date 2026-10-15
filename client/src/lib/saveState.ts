/**
 * Editor save-state machine (AC-SAVE-STATE, EC-5, EC-6, EC-8). Pure so it can be
 * unit-tested without a browser.
 */
import { ApiError, NetworkError } from "./api";

export type SaveStatus = "saved" | "unsaved" | "saving" | "error" | "conflict" | "blocked";

export interface SaveState {
  status: SaveStatus;
  /** Editor content differs from the last successfully saved content. */
  dirty: boolean;
  /** Revision the next save is based on. */
  revision: number;
  /** Message for error/conflict/blocked states. */
  message: string | null;
  /** Whether "Retry" makes sense for the current error. */
  retryable: boolean;
  /** Server revision reported by a 409. */
  conflictRevision: number | null;
}

export type SaveEvent =
  | { type: "EDITED"; dirty: boolean }
  | { type: "SAVE_STARTED" }
  | { type: "SAVE_SUCCEEDED"; revision: number; dirty: boolean }
  | { type: "SAVE_FAILED"; message: string; retryable: boolean }
  | { type: "SAVE_CONFLICT"; message: string; currentRevision: number | null }
  | { type: "ACCESS_LOST"; message: string }
  | { type: "SYNCED"; revision: number };

export function initialSaveState(revision: number): SaveState {
  return { status: "saved", dirty: false, revision, message: null, retryable: false, conflictRevision: null };
}

export function saveReducer(state: SaveState, event: SaveEvent): SaveState {
  switch (event.type) {
    case "EDITED":
      // Errors, conflicts and lost access stay visible until resolved; edits are kept.
      if (state.status === "saving" || state.status === "error" || state.status === "conflict" || state.status === "blocked") {
        return { ...state, dirty: event.dirty };
      }
      return { ...state, dirty: event.dirty, status: event.dirty ? "unsaved" : "saved" };
    case "SAVE_STARTED":
      return { ...state, status: "saving", message: null, retryable: false };
    case "SAVE_SUCCEEDED":
      return {
        ...state,
        status: event.dirty ? "unsaved" : "saved",
        dirty: event.dirty,
        revision: event.revision,
        message: null,
        retryable: false,
        conflictRevision: null,
      };
    case "SAVE_FAILED":
      return { ...state, status: "error", message: event.message, retryable: event.retryable };
    case "SAVE_CONFLICT":
      return { ...state, status: "conflict", message: event.message, conflictRevision: event.currentRevision };
    case "ACCESS_LOST":
      return { ...state, status: "blocked", message: event.message, retryable: false };
    case "SYNCED":
      // Content replaced from the server (reload latest / restore).
      return initialSaveState(event.revision);
  }
}

/** Save button / Ctrl+S may run a normal save. Conflicts must go through the dialog. */
export function canSave(state: SaveState): boolean {
  if (state.status === "saving" || state.status === "blocked" || state.status === "conflict") return false;
  return state.dirty || state.status === "error";
}

export function statusLabel(state: SaveState): string {
  switch (state.status) {
    case "saved":
      return "Saved";
    case "unsaved":
      return "Unsaved changes";
    case "saving":
      return "Saving…";
    case "error":
      return "Error";
    case "conflict":
      return "Conflict";
    case "blocked":
      return "Not saved";
  }
}

export type SaveFailure =
  | { kind: "conflict"; message: string; currentRevision: number | null }
  | { kind: "forbidden"; message: string }
  | { kind: "gone"; message: string }
  | { kind: "unauthorized"; message: string }
  | { kind: "retryable"; message: string }
  | { kind: "fatal"; message: string };

/** Maps a thrown save error to how the editor should react. */
export function classifySaveError(err: unknown): SaveFailure {
  if (err instanceof NetworkError) {
    return { kind: "retryable", message: "Couldn't reach the server. Your changes are still here." };
  }
  if (err instanceof ApiError) {
    switch (err.status) {
      case 409: {
        const rev = err.body.currentRevision;
        return {
          kind: "conflict",
          message: err.message,
          currentRevision: typeof rev === "number" ? rev : null,
        };
      }
      case 403:
        return { kind: "forbidden", message: "You no longer have permission to edit this document." };
      case 404:
        return { kind: "gone", message: "This document was deleted or your access was removed." };
      case 401:
        return { kind: "unauthorized", message: "Your session has expired. Please sign in again." };
      case 400:
      case 413:
        return { kind: "fatal", message: err.message };
      default:
        if (err.status >= 500) return { kind: "retryable", message: "The server had a problem saving. Try again." };
        return { kind: "fatal", message: err.message };
    }
  }
  return { kind: "retryable", message: "Saving failed unexpectedly. Try again." };
}
