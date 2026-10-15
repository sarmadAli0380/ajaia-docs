import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { DocumentLists, DocumentSummary } from "../../../shared/api";
import { AppHeader } from "../components/AppHeader";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ImportDialog } from "../components/ImportDialog";
import { useToast } from "../components/Toasts";
import { api, ApiError, errorMessage } from "../lib/api";
import { formatAbsolute, formatRelative } from "../lib/format";

const ROLE_LABEL = { owner: "Owner", editor: "Can edit", viewer: "Can view" } as const;

function DocCard({ doc, onDelete }: { doc: DocumentSummary; onDelete?: (doc: DocumentSummary) => void }) {
  return (
    <li className="doc-card">
      <div className="doc-card-main">
        <Link to={`/documents/${doc.id}`} className="doc-card-title truncate" title={doc.title}>
          {doc.title}
        </Link>
        <div className="doc-card-meta">
          <span className="doc-card-owner truncate">
            {doc.role === "owner" ? "You" : doc.owner.name}
            <span className="sr-only"> (owner)</span>
          </span>
          <span className={`badge badge-${doc.role}`}>{ROLE_LABEL[doc.role]}</span>
          <time className="doc-card-time" dateTime={doc.updatedAt} title={formatAbsolute(doc.updatedAt)}>
            Updated {formatRelative(doc.updatedAt)}
          </time>
        </div>
      </div>
      {onDelete ? (
        <div className="doc-card-actions">
          <button
            type="button"
            className="button button-ghost button-small button-danger-text"
            onClick={() => onDelete(doc)}
            aria-label={`Delete ${doc.title}`}
          >
            Delete
          </button>
        </div>
      ) : null}
    </li>
  );
}

function DocSection({
  title,
  docs,
  empty,
  onDelete,
}: {
  title: string;
  docs: DocumentSummary[];
  empty: React.ReactNode;
  onDelete?: (doc: DocumentSummary) => void;
}) {
  const headingId = `section-${title.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <section className="doc-section" aria-labelledby={headingId}>
      <div className="doc-section-header">
        <h2 id={headingId}>{title}</h2>
        <span className="count" aria-label={`${docs.length} documents`}>
          {docs.length}
        </span>
      </div>
      {docs.length === 0 ? (
        <div className="empty-state">{empty}</div>
      ) : (
        <>
          <div className="doc-table-head" aria-hidden="true">
            <span>Title</span>
            <span>Owner</span>
            <span>Access</span>
            <span>Last updated</span>
            <span />
          </div>
          <ul className="doc-list">
            {docs.map((d) => (
              <DocCard key={d.id} doc={d} onDelete={onDelete} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function DashboardPage() {
  const navigate = useNavigate();
  const { notify } = useToast();
  const [lists, setLists] = useState<DocumentLists | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [toDelete, setToDelete] = useState<DocumentSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setLists(await api.listDocuments());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return; // handled globally
      setLoadError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (creating) return; // EC-9
    setCreating(true);
    try {
      const doc = await api.createDocument();
      navigate(`/documents/${doc.id}`);
    } catch (err) {
      notify(errorMessage(err), "error");
      setCreating(false);
    }
  };

  const confirmDelete = async () => {
    if (!toDelete || deleting) return;
    setDeleting(true);
    try {
      await api.deleteDocument(toDelete.id);
      notify(`Deleted "${toDelete.title}"`, "success");
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) notify(errorMessage(err), "error");
    } finally {
      setDeleting(false);
      setToDelete(null);
      void load();
    }
  };

  return (
    <div className="page">
      <AppHeader>
        <button
          type="button"
          className="button button-primary"
          onClick={() => void create()}
          disabled={creating}
          aria-label={creating ? "Creating document" : "New document"}
        >
          <span className="button-icon" aria-hidden="true">
            +
          </span>
          <span className="label-collapsible">{creating ? "Creating…" : "New document"}</span>
        </button>
        <button
          type="button"
          className="button"
          onClick={() => setImporting(true)}
          disabled={creating}
          aria-label="Import file"
        >
          <span className="button-icon" aria-hidden="true">
            ⤒
          </span>
          <span className="label-collapsible">Import</span>
        </button>
      </AppHeader>
      <main className="dashboard">
        {loadError ? (
          <div className="notice notice-error" role="alert">
            <p>{loadError}</p>
            <button type="button" className="button" onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : lists === null ? (
          <p className="muted">Loading documents…</p>
        ) : (
          <>
            <DocSection
              title="My documents"
              docs={lists.owned}
              onDelete={setToDelete}
              empty={
                <>
                  <p>You don't have any documents yet.</p>
                  <p className="muted">Create a new document or import a .txt, .md or .docx file.</p>
                </>
              }
            />
            <DocSection
              title="Shared with me"
              docs={lists.shared}
              empty={
                <>
                  <p>Nothing has been shared with you yet.</p>
                  <p className="muted">Documents other people share with you will appear here.</p>
                </>
              }
            />
          </>
        )}
      </main>

      {importing ? (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImported={(doc) => {
            setImporting(false);
            notify(`Imported "${doc.title}"`, "success");
            navigate(`/documents/${doc.id}`);
          }}
        />
      ) : null}

      {toDelete ? (
        <ConfirmDialog
          title="Delete document?"
          confirmLabel="Delete"
          danger
          pending={deleting}
          onCancel={() => setToDelete(null)}
          onConfirm={() => void confirmDelete()}
        >
          <p>
            <strong className="break-anywhere">{toDelete.title}</strong> will be permanently deleted for everyone,
            including its sharing settings and version history. This can't be undone.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
