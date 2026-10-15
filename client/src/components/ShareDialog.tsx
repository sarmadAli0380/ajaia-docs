import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { Share, User } from "../../../shared/api";
import type { ShareRole } from "../../../shared/limits";
import { api, ApiError, errorMessage } from "../lib/api";
import { Modal } from "./Modal";

interface ShareDialogProps {
  documentId: string;
  documentTitle: string;
  ownerId: string;
  onClose(): void;
}

/** Owner-only sharing: grant viewer/editor, change role, revoke (AC-SHARE). */
export function ShareDialog({ documentId, documentTitle, ownerId, onClose }: ShareDialogProps) {
  const userSelectId = useId();
  const roleSelectId = useId();
  const [users, setUsers] = useState<User[] | null>(null);
  const [shares, setShares] = useState<Share[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState("");
  const [role, setRole] = useState<ShareRole>("viewer");
  /** Id of the user whose share is being changed, or "new" for the add form. */
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [u, s] = await Promise.all([api.listUsers(), api.listShares(documentId)]);
      setUsers(u);
      setShares(s);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const candidates = useMemo(() => {
    if (!users || !shares) return [];
    const shared = new Set(shares.map((s) => s.user.id));
    return users.filter((u) => u.id !== ownerId && !shared.has(u.id));
  }, [users, shares, ownerId]);

  useEffect(() => {
    if (!candidates.some((c) => c.id === selectedUser)) setSelectedUser(candidates[0]?.id ?? "");
  }, [candidates, selectedUser]);

  const handleError = (err: unknown) => {
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
      setError("You can no longer manage sharing for this document.");
    } else {
      setError(errorMessage(err));
    }
  };

  const upsert = async (userId: string, newRole: ShareRole, key: string) => {
    if (pending) return; // EC-9
    setPending(key);
    setError(null);
    try {
      const share = await api.upsertShare(documentId, userId, newRole);
      setShares((all) => {
        const rest = (all ?? []).filter((s) => s.user.id !== share.user.id);
        return [...rest, share].sort((a, b) => a.user.name.localeCompare(b.user.name));
      });
    } catch (err) {
      handleError(err);
    } finally {
      setPending(null);
    }
  };

  const revoke = async (userId: string) => {
    if (pending) return;
    setPending(userId);
    setError(null);
    try {
      await api.revokeShare(documentId, userId);
      setShares((all) => (all ?? []).filter((s) => s.user.id !== userId));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404 && err.message === "Share not found") {
        setShares((all) => (all ?? []).filter((s) => s.user.id !== userId));
      } else {
        handleError(err);
      }
    } finally {
      setPending(null);
    }
  };

  const otherUsers = users?.filter((u) => u.id !== ownerId) ?? [];

  return (
    <Modal title="Share document" onClose={onClose} busy={pending !== null}>
      <p className="muted truncate" title={documentTitle}>
        {documentTitle}
      </p>
      {loadError ? (
        <div className="notice notice-error" role="alert">
          <p>{loadError}</p>
          <button type="button" className="button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : users === null || shares === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          {candidates.length > 0 ? (
            <form
              className="share-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (selectedUser) void upsert(selectedUser, role, "new");
              }}
            >
              <div className="field">
                <label htmlFor={userSelectId}>Person</label>
                <select
                  id={userSelectId}
                  value={selectedUser}
                  onChange={(e) => setSelectedUser(e.target.value)}
                  disabled={pending !== null}
                  data-autofocus
                >
                  {candidates.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.email})
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor={roleSelectId}>Access</label>
                <select
                  id={roleSelectId}
                  value={role}
                  onChange={(e) => setRole(e.target.value as ShareRole)}
                  disabled={pending !== null}
                >
                  <option value="viewer">Can view</option>
                  <option value="editor">Can edit</option>
                </select>
              </div>
              <button
                type="submit"
                className="button button-primary"
                disabled={!selectedUser}
                // aria-disabled while pending keeps focus on the clicked button (upsert ignores repeats).
                aria-disabled={pending !== null ? "true" : undefined}
              >
                {pending === "new" ? "Sharing…" : "Share"}
              </button>
            </form>
          ) : (
            <p className="empty-state empty-state-compact">
              {otherUsers.length === 0
                ? "There are no other users to share with."
                : "Everyone else already has access. Change their access below."}
            </p>
          )}

          {error ? (
            <p className="notice notice-error" role="alert">
              {error}
            </p>
          ) : null}

          <h3 className="subheading">People with access</h3>
          {shares.length === 0 ? (
            <p className="empty-state empty-state-compact">Not shared with anyone yet. Only you can open it.</p>
          ) : (
            <ul className="share-list">
              {shares.map((s) => (
                <li key={s.user.id} className="share-row">
                  <span className="avatar" aria-hidden="true">
                    {s.user.name.slice(0, 1)}
                  </span>
                  <span className="share-person">
                    <span className="share-name truncate">{s.user.name}</span>
                    <span className="share-email truncate">{s.user.email}</span>
                  </span>
                  <select
                    aria-label={`Access for ${s.user.name}`}
                    value={s.role}
                    disabled={pending !== null}
                    onChange={(e) => void upsert(s.user.id, e.target.value as ShareRole, s.user.id)}
                  >
                    <option value="viewer">Can view</option>
                    <option value="editor">Can edit</option>
                  </select>
                  <button
                    type="button"
                    className="button button-ghost button-small button-danger-text"
                    onClick={() => void revoke(s.user.id)}
                    aria-disabled={pending !== null ? "true" : undefined}
                    aria-label={`Remove access for ${s.user.name}`}
                  >
                    {pending === s.user.id ? "…" : "Remove"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Modal>
  );
}
