import { useId, useState } from "react";
import type { DocumentDetail } from "../../../shared/api";
import { MAX_CONTENT_BYTES, MAX_UPLOAD_BYTES, SUPPORTED_IMPORT_EXTENSIONS, formatBytes } from "../../../shared/limits";
import { api, errorMessage } from "../lib/api";
import { Modal } from "./Modal";

const ACCEPT = SUPPORTED_IMPORT_EXTENSIONS.join(",");
const TYPES_LABEL = SUPPORTED_IMPORT_EXTENSIONS.join(", ");

/** Early client-side feedback; the server re-validates everything. */
function precheck(file: File): string | null {
  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
  if (!(SUPPORTED_IMPORT_EXTENSIONS as readonly string[]).includes(ext)) {
    return `Unsupported file type. Supported types: ${TYPES_LABEL}.`;
  }
  if (file.size === 0) return "The file is empty.";
  if (file.size > MAX_UPLOAD_BYTES) return `File is too large (maximum ${formatBytes(MAX_UPLOAD_BYTES)}).`;
  return null;
}

export function ImportDialog({ onClose, onImported }: { onClose(): void; onImported(doc: DocumentDetail): void }) {
  const inputId = useId();
  const hintId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const upload = async () => {
    if (!file || pending) return;
    const problem = precheck(file);
    if (problem) {
      setError(problem);
      return;
    }
    setPending(true);
    setError(null);
    try {
      onImported(await api.importDocument(file));
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  };

  return (
    <Modal
      title="Import a file"
      onClose={onClose}
      busy={pending}
      footer={
        <>
          <button type="button" className="button" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void upload()}
            disabled={!file || error !== null}
            // aria-disabled while uploading keeps focus on the button (upload ignores repeats).
            aria-disabled={pending ? "true" : undefined}
          >
            {pending ? "Importing…" : "Import"}
          </button>
        </>
      }
    >
      <p id={hintId} className="muted">
        Supported types: <strong>{TYPES_LABEL}</strong>, up to <strong>{formatBytes(MAX_UPLOAD_BYTES)}</strong>. The
        file becomes a new document you own. Converted content must fit the {formatBytes(MAX_CONTENT_BYTES)} document
        limit.
      </p>
      <label htmlFor={inputId} className="file-drop">
        <span className="file-drop-label">{file ? "Choose a different file" : "Choose a file"}</span>
        <input
          id={inputId}
          type="file"
          accept={ACCEPT}
          aria-describedby={hintId}
          disabled={pending}
          data-autofocus
          onChange={(e) => {
            const chosen = e.target.files?.[0] ?? null;
            setFile(chosen);
            setError(chosen ? precheck(chosen) : null);
          }}
        />
      </label>
      {file ? (
        <p className="file-chosen">
          <span className="truncate" title={file.name}>
            {file.name}
          </span>
          <span className="muted"> · {formatBytes(file.size)}</span>
        </p>
      ) : null}
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
