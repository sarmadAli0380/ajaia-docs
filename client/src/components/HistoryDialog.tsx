import { useCallback, useEffect, useState } from "react";
import type { RestoreResult, VersionDetail, VersionSummary } from "../../../shared/api";
import { VERSION_RETENTION } from "../../../shared/limits";
import { api, errorMessage } from "../lib/api";
import { formatAbsolute, formatRelative } from "../lib/format";
import { Modal } from "./Modal";
import { ReadOnlyContent } from "./ReadOnlyContent";

interface HistoryDialogProps {
  documentId: string;
  canRestore: boolean;
  /** Unsaved edits in the open editor (EC-17). */
  hasUnsavedChanges: boolean;
  onRestored(result: RestoreResult): void;
  onClose(): void;
}

function sourceLabel(v: VersionSummary): string {
  if (v.source === "import") return "Imported";
  if (v.source === "restore") return v.restoredFromRevision ? `Restored from v${v.restoredFromRevision}` : "Restored";
  return "Saved";
}

/** Version list, preview and restore (AC-VERSIONS). Restore asks for in-app confirmation. */
export function HistoryDialog({ documentId, canRestore, hasUnsavedChanges, onRestored, onClose }: HistoryDialogProps) {
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<VersionDetail | null>(null);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setVersions(await api.listVersions(documentId));
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (v: VersionSummary) => {
    setPreviewLoading(v.id);
    setError(null);
    setConfirming(false);
    try {
      setSelected(await api.getVersion(documentId, v.id));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPreviewLoading(null);
    }
  };

  const restore = async () => {
    if (!selected || restoring) return;
    setRestoring(true);
    setError(null);
    try {
      const result = await api.restoreVersion(documentId, selected.id);
      onRestored(result);
    } catch (err) {
      setError(errorMessage(err));
      setRestoring(false);
      setConfirming(false);
    }
  };

  const footer = selected ? (
    confirming ? (
      <div className="confirm-inline" role="alertdialog" aria-label="Confirm restore">
        <p>
          {hasUnsavedChanges ? (
            <strong>You have unsaved changes. They will be lost if you restore v{selected.revision}.</strong>
          ) : (
            <>Restore v{selected.revision}? The current content is replaced; earlier saves stay in history.</>
          )}
        </p>
        <div className="confirm-inline-actions">
          <button type="button" className="button" onClick={() => setConfirming(false)} disabled={restoring}>
            Cancel
          </button>
          <button
            type="button"
            className={`button ${hasUnsavedChanges ? "button-danger" : "button-primary"}`}
            onClick={() => void restore()}
            disabled={restoring}
          >
            {restoring ? "Restoring…" : hasUnsavedChanges ? "Discard changes and restore" : "Restore"}
          </button>
        </div>
      </div>
    ) : (
      <>
        <button type="button" className="button history-back" onClick={() => setSelected(null)}>
          ← All versions
        </button>
        {canRestore ? (
          <button type="button" className="button button-primary" onClick={() => setConfirming(true)}>
            Restore this version
          </button>
        ) : (
          <span className="muted">Viewers can't restore versions.</span>
        )}
      </>
    )
  ) : undefined;

  return (
    <Modal title="Version history" onClose={onClose} busy={restoring} size="large" footer={footer}>
      {loadError ? (
        <div className="notice notice-error" role="alert">
          <p>{loadError}</p>
          <button type="button" className="button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : versions === null ? (
        <p className="muted">Loading…</p>
      ) : versions.length === 0 ? (
        <div className="empty-state">
          <p>No versions yet.</p>
          <p className="muted">A version is recorded every time the document is saved.</p>
        </div>
      ) : (
        <div className={`history ${selected ? "history-has-selection" : ""}`}>
          <ol className="version-list" aria-label="Versions, newest first">
            {versions.map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  className={`version-item ${selected?.id === v.id ? "is-selected" : ""}`}
                  aria-current={selected?.id === v.id ? "true" : undefined}
                  onClick={() => {
                    if (previewLoading !== null || restoring) return;
                    void open(v);
                  }}
                  // aria-disabled (not disabled) so the clicked row keeps focus while loading.
                  aria-disabled={previewLoading !== null || restoring ? "true" : undefined}
                >
                  <span className="version-title">
                    v{v.revision} · {sourceLabel(v)}
                  </span>
                  <span className="version-meta">
                    <time dateTime={v.createdAt} title={formatAbsolute(v.createdAt)}>
                      {formatRelative(v.createdAt)}
                    </time>
                    {v.createdBy ? ` · ${v.createdBy.name}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <div className="version-preview" aria-live="polite">
            {selected ? (
              <>
                <p className="version-preview-label">
                  Preview of v{selected.revision} · {formatAbsolute(selected.createdAt)}
                </p>
                <ReadOnlyContent key={selected.id} html={selected.content} label={`Version ${selected.revision}`} />
              </>
            ) : (
              <p className="muted version-preview-empty">
                {previewLoading ? "Loading preview…" : "Select a version to preview it."}
              </p>
            )}
          </div>
          {versions.length >= VERSION_RETENTION ? (
            <p className="muted history-note">Only the latest {VERSION_RETENTION} versions are kept.</p>
          ) : null}
        </div>
      )}
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
