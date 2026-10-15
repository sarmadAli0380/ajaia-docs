import { EditorContent, useEditor } from "@tiptap/react";
import { useCallback, useEffect, useId, useReducer, useRef, useState } from "react";
import { Link, useBlocker, useParams } from "react-router-dom";
import type { DocumentDetail, RestoreResult } from "../../../shared/api";
import { MAX_TITLE_LENGTH } from "../../../shared/limits";
import { HistoryDialog } from "../components/HistoryDialog";
import { Modal } from "../components/Modal";
import { MoreMenu, type MenuItem } from "../components/MoreMenu";
import { ShareDialog } from "../components/ShareDialog";
import { useToast } from "../components/Toasts";
import { Toolbar } from "../components/Toolbar";
import { api, ApiError, errorMessage } from "../lib/api";
import { copyText, downloadBlob } from "../lib/browser";
import { createExtensions } from "../lib/editorExtensions";
import { codePointLength, normalizeTitle } from "../lib/format";
import { canSave, classifySaveError, initialSaveState, saveReducer, statusLabel } from "../lib/saveState";

export function EditorPage() {
  const { id = "" } = useParams();
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [loadError, setLoadError] = useState<{ notFound: boolean; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setLoadError(null);
    api
      .getDocument(id)
      .then((d) => !cancelled && setDoc(d))
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) return; // global redirect
        setLoadError({
          notFound: err instanceof ApiError && err.status === 404,
          message: errorMessage(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  if (loadError) {
    return (
      <main className="center-page">
        <div className="panel">
          <h1>{loadError.notFound ? "Document not found" : "Couldn't open the document"}</h1>
          <p className="muted">
            {loadError.notFound
              ? "It may have been deleted, or you don't have access to it."
              : loadError.message}
          </p>
          <div className="panel-actions">
            {!loadError.notFound ? (
              <button type="button" className="button" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            ) : null}
            <Link to="/" className="button button-primary">
              Back to documents
            </Link>
          </div>
        </div>
      </main>
    );
  }
  if (!doc) {
    return (
      <main className="center-page">
        <p className="muted">Opening document…</p>
      </main>
    );
  }
  return <DocumentEditor key={doc.id} initial={doc} />;
}

const VIEW_ONLY_MESSAGE = "This document is view-only for you, so changes can't be made or saved.";

function DocumentEditor({ initial }: { initial: DocumentDetail }) {
  const docId = initial.id;
  const { notify } = useToast();
  const titleErrorId = useId();

  const [role, setRole] = useState(initial.role);
  const [title, setTitle] = useState(initial.title);
  const [titleDraft, setTitleDraft] = useState(initial.title);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [state, dispatch] = useReducer(saveReducer, initial.revision, initialSaveState);
  const [dialog, setDialog] = useState<null | "share" | "history" | "conflict">(null);
  const [resolving, setResolving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [hintPulse, setHintPulse] = useState(0);

  const savedHtmlRef = useRef("");
  const stateRef = useRef(state);
  stateRef.current = state;
  const savingRef = useRef(false);

  const accessLost = state.status === "blocked";
  const isViewer = role === "viewer";
  const canEdit = !isViewer && !accessLost;
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;

  const editor = useEditor({
    extensions: createExtensions(),
    content: initial.content,
    editable: initial.role !== "viewer",
    editorProps: {
      attributes: { class: "prose", "aria-label": "Document content", "aria-multiline": "true", role: "textbox" },
    },
    onCreate: ({ editor: e }) => {
      savedHtmlRef.current = e.getHTML();
    },
    onUpdate: ({ editor: e }) => {
      dispatch({ type: "EDITED", dirty: e.getHTML() !== savedHtmlRef.current });
    },
  });

  useEffect(() => {
    if (editor && editor.isEditable !== canEdit) editor.setEditable(canEdit, false);
  }, [editor, canEdit]);

  useEffect(() => {
    document.title = `${title} · Ajaia Docs`;
    return () => {
      document.title = "Ajaia Docs";
    };
  }, [title]);

  const explainReadOnly = useCallback(() => {
    setHintPulse((n) => n + 1);
    notify(VIEW_ONLY_MESSAGE);
  }, [notify]);

  /** Applies a failure from save/rename/export to the editor state. Returns true if handled as lost access. */
  const handleAccessFailure = useCallback((err: unknown): boolean => {
    const failure = classifySaveError(err);
    if (failure.kind === "forbidden") {
      setRole("viewer");
      dispatch({ type: "ACCESS_LOST", message: failure.message });
      return true;
    }
    if (failure.kind === "gone") {
      dispatch({ type: "ACCESS_LOST", message: failure.message });
      return true;
    }
    return false;
  }, []);

  const performSave = useCallback(
    async (baseRevision?: number): Promise<boolean> => {
      if (!editor || savingRef.current) return false;
      const html = editor.getHTML();
      savingRef.current = true;
      dispatch({ type: "SAVE_STARTED" });
      try {
        const res = await api.saveContent(docId, html, baseRevision ?? stateRef.current.revision);
        savedHtmlRef.current = html;
        dispatch({ type: "SAVE_SUCCEEDED", revision: res.revision, dirty: editor.getHTML() !== html });
        return true;
      } catch (err) {
        const failure = classifySaveError(err);
        if (failure.kind === "conflict") {
          dispatch({ type: "SAVE_CONFLICT", message: failure.message, currentRevision: failure.currentRevision });
          setDialog("conflict");
        } else if (!handleAccessFailure(err)) {
          dispatch({ type: "SAVE_FAILED", message: failure.message, retryable: failure.kind === "retryable" });
        }
        return false;
      } finally {
        savingRef.current = false;
      }
    },
    [docId, editor, handleAccessFailure],
  );

  const save = useCallback(() => {
    if (!canEditRef.current) {
      explainReadOnly(); // EC-16
      return;
    }
    const current = stateRef.current;
    if (current.status === "conflict") {
      setDialog("conflict");
      return;
    }
    if (!canSave(current)) return; // nothing to save, or a save is already running (EC-9)
    void performSave();
  }, [explainReadOnly, performSave]);

  const saveRef = useRef(save);
  saveRef.current = save;

  // Ctrl/Cmd+S anywhere on the page (AC-EDIT, EC-16).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Closing/reloading the tab with unsaved changes (EC-19).
  useEffect(() => {
    if (!state.dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [state.dirty]);

  // In-app navigation (links, back/forward) with unsaved changes (EC-19).
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      stateRef.current.dirty && currentLocation.pathname !== nextLocation.pathname,
  );

  const copyMine = useCallback(async () => {
    if (!editor) return;
    const ok = await copyText(editor.getText({ blockSeparator: "\n\n" }));
    notify(ok ? "Your text was copied to the clipboard." : "Couldn't copy automatically. Select the text and copy it.", ok ? "success" : "error");
  }, [editor, notify]);

  const commitTitle = async () => {
    if (!canEdit || renaming) return;
    const next = normalizeTitle(titleDraft);
    if (next === title) {
      setTitleDraft(title);
      setTitleError(null);
      return;
    }
    if (!next) {
      setTitleError("Title can't be empty.");
      return;
    }
    if (codePointLength(next) > MAX_TITLE_LENGTH) {
      setTitleError(`Title must be at most ${MAX_TITLE_LENGTH} characters.`);
      return;
    }
    setRenaming(true);
    setTitleError(null);
    try {
      const updated = await api.renameDocument(docId, next);
      setTitle(updated.title);
      setTitleDraft(updated.title);
    } catch (err) {
      if (handleAccessFailure(err)) {
        setTitleDraft(title);
      } else {
        setTitleError(errorMessage(err));
      }
    } finally {
      setRenaming(false);
    }
  };

  const reloadLatest = async () => {
    if (!editor || resolving) return;
    setResolving(true);
    try {
      const latest = await api.getDocument(docId);
      editor.commands.setContent(latest.content, false);
      savedHtmlRef.current = editor.getHTML();
      setTitle(latest.title);
      setTitleDraft(latest.title);
      setRole(latest.role);
      dispatch({ type: "SYNCED", revision: latest.revision });
      setDialog(null);
      notify("Loaded the latest version.", "success");
    } catch (err) {
      if (handleAccessFailure(err)) setDialog(null);
      else notify(errorMessage(err), "error");
    } finally {
      setResolving(false);
    }
  };

  const keepMine = async () => {
    if (resolving) return;
    setResolving(true);
    try {
      const latest = await api.getDocument(docId);
      if (latest.role === "viewer") {
        setRole("viewer");
        dispatch({ type: "ACCESS_LOST", message: "You no longer have permission to edit this document." });
        setDialog(null);
        return;
      }
      setDialog(null);
      // Explicit overwrite: save my content on top of the newest revision (may conflict again).
      const ok = await performSave(latest.revision);
      if (ok) notify("Your version was saved. The other version is still in history.", "success");
    } catch (err) {
      if (handleAccessFailure(err)) setDialog(null);
      else notify(errorMessage(err), "error");
    } finally {
      setResolving(false);
    }
  };

  const onRestored = (result: RestoreResult) => {
    if (!editor) return;
    editor.commands.setContent(result.content, false);
    savedHtmlRef.current = editor.getHTML();
    dispatch({ type: "SYNCED", revision: result.revision });
    setDialog(null);
    notify(`Restored version ${result.restoredFromRevision}.`, "success");
  };

  const exportMarkdown = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const { blob, filename } = await api.exportMarkdown(docId);
      downloadBlob(blob, filename);
      if (stateRef.current.dirty) notify("Exported the last saved version. Save first to include your latest changes.");
    } catch (err) {
      if (!handleAccessFailure(err)) notify(errorMessage(err), "error");
    } finally {
      setExporting(false);
    }
  };

  const isOwner = role === "owner";
  const secondaryItems: MenuItem[] = [
    ...(isOwner && !accessLost ? [{ label: "Share", onSelect: () => setDialog("share") }] : []),
    { label: "Version history", onSelect: () => setDialog("history"), disabled: accessLost },
    { label: exporting ? "Exporting…" : "Export as Markdown", onSelect: () => void exportMarkdown(), disabled: exporting || accessLost },
  ];

  const statusText = isViewer && !accessLost ? "View only" : statusLabel(state);
  const saveDisabled = !canEdit || !canSave(state);

  return (
    <div className="page editor-page">
      <div className="editor-chrome">
      <header className="editor-header">
        <Link to="/" className="icon-button back-link" aria-label="Back to documents" title="Back to documents">
          ←
        </Link>
        <div className="title-area">
          {canEdit ? (
            <input
              className={`title-input ${titleError ? "is-invalid" : ""}`}
              value={titleDraft}
              onChange={(e) => {
                setTitleDraft(e.target.value);
                if (titleError) setTitleError(null);
              }}
              onBlur={() => void commitTitle()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  setTitleDraft(title);
                  setTitleError(null);
                  e.currentTarget.blur();
                }
              }}
              disabled={renaming}
              aria-label="Document title"
              aria-invalid={titleError ? true : undefined}
              aria-describedby={titleError ? titleErrorId : undefined}
              title={titleDraft}
            />
          ) : (
            <h1 className="title-text truncate" title={title}>
              {title}
            </h1>
          )}
          <div className="title-meta">
            <span className="truncate">
              {isOwner ? "Owned by you" : `Owned by ${initial.owner.name}`} ·{" "}
              {isOwner ? "Owner" : isViewer ? "Can view" : "Can edit"}
            </span>
            <span className={`save-status status-${isViewer && !accessLost ? "viewonly" : state.status}`} role="status" aria-live="polite">
              {statusText}
            </span>
          </div>
          {titleError ? (
            <p id={titleErrorId} className="field-error" role="alert">
              {titleError}
            </p>
          ) : null}
        </div>
        <div className="editor-actions">
          {!isViewer ? (
            <button
              type="button"
              className="button button-primary"
              onClick={save}
              disabled={saveDisabled}
              title="Save (Ctrl/Cmd+S)"
            >
              {state.status === "saving" ? "Saving…" : "Save"}
            </button>
          ) : null}
          <div className="secondary-actions">
            {secondaryItems.map((item) => (
              <button key={item.label} type="button" className="button" onClick={item.onSelect} disabled={item.disabled}>
                {item.label}
              </button>
            ))}
          </div>
          <div className="overflow-actions">
            <MoreMenu items={secondaryItems} />
          </div>
        </div>
      </header>

      {!isViewer ? <Toolbar editor={editor} disabled={!canEdit} /> : null}
      </div>

      <div className="banners">
        {accessLost ? (
          <div className="banner banner-error" role="alert">
            <p>
              <strong>{state.message}</strong> Your text is still on this page. Copy it before leaving if you want to
              keep it.
            </p>
            <div className="banner-actions">
              <button type="button" className="button" onClick={() => void copyMine()}>
                Copy my text
              </button>
              <Link to="/" className="button button-primary">
                Back to documents
              </Link>
            </div>
          </div>
        ) : null}
        {isViewer && !accessLost ? (
          <div key={hintPulse} className={`banner banner-info ${hintPulse > 0 ? "pulse" : ""}`}>
            <p>
              <strong>View only.</strong> You can read, export and browse the history of this document, but not edit
              it. Ask {initial.owner.name} for edit access.
            </p>
          </div>
        ) : null}
        {state.status === "error" ? (
          <div className="banner banner-error" role="alert">
            <p>
              <strong>Not saved.</strong> {state.message} Your changes are still here.
            </p>
            <div className="banner-actions">
              {state.retryable ? (
                <button type="button" className="button button-primary" onClick={() => void performSave()}>
                  Retry
                </button>
              ) : null}
              <button type="button" className="button" onClick={() => void copyMine()}>
                Copy my text
              </button>
            </div>
          </div>
        ) : null}
        {state.status === "conflict" && dialog !== "conflict" ? (
          <div className="banner banner-warning" role="alert">
            <p>
              <strong>Not saved.</strong> Someone else changed this document since you opened it.
            </p>
            <div className="banner-actions">
              <button type="button" className="button button-primary" onClick={() => setDialog("conflict")}>
                Resolve…
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <main className="editor-scroll">
        <div
          className={`editor-paper ${canEdit ? "" : "is-readonly"}`}
          onKeyDown={(e) => {
            if (canEdit || e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.key.length === 1 || e.key === "Enter" || e.key === "Backspace" || e.key === "Delete") {
              explainReadOnly(); // EC-16: typing as a viewer does nothing, and says why
            }
          }}
        >
          <EditorContent editor={editor} />
        </div>
      </main>

      {dialog === "share" ? (
        <ShareDialog documentId={docId} documentTitle={title} ownerId={initial.owner.id} onClose={() => setDialog(null)} />
      ) : null}

      {dialog === "history" ? (
        <HistoryDialog
          documentId={docId}
          canRestore={canEdit}
          hasUnsavedChanges={state.dirty}
          onRestored={onRestored}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog === "conflict" ? (
        <Modal
          title="This document was changed"
          onClose={() => setDialog(null)}
          busy={resolving}
          alert
          footer={
            <>
              <button type="button" className="button" onClick={() => void copyMine()} disabled={resolving}>
                Copy my text
              </button>
              <button type="button" className="button" onClick={() => void reloadLatest()} disabled={resolving} data-autofocus>
                Reload latest
              </button>
              <button type="button" className="button button-danger" onClick={() => void keepMine()} disabled={resolving}>
                Keep my copy
              </button>
            </>
          }
        >
          <p>
            Someone else saved a newer version
            {state.conflictRevision ? ` (v${state.conflictRevision})` : ""} while you were editing. Your changes have
            not been saved.
          </p>
          <ul className="choice-list">
            <li>
              <strong>Reload latest</strong>: discard your unsaved changes and show the newest version.
            </li>
            <li>
              <strong>Keep my copy</strong>: save your version over theirs. Theirs stays in version history.
            </li>
            <li>
              <strong>Copy my text</strong>: copy your content to the clipboard first, then decide.
            </li>
          </ul>
        </Modal>
      ) : null}

      {blocker.state === "blocked" ? (
        <Modal
          title="Leave without saving?"
          onClose={() => blocker.reset()}
          alert
          size="small"
          footer={
            <>
              <button type="button" className="button" onClick={() => blocker.reset()} data-autofocus>
                Stay
              </button>
              {canEdit && canSave(state) ? (
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => {
                    void performSave().then((ok) => {
                      if (ok) blocker.proceed();
                      else blocker.reset();
                    });
                  }}
                >
                  Save and leave
                </button>
              ) : null}
              <button type="button" className="button button-danger" onClick={() => blocker.proceed()}>
                Leave without saving
              </button>
            </>
          }
        >
          <p>You have unsaved changes in this document. If you leave now, they will be lost.</p>
        </Modal>
      ) : null}
    </div>
  );
}
