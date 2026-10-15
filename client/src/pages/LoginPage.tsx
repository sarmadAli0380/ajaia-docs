import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import type { User } from "../../../shared/api";
import { useAuth } from "../auth";
import { api, errorMessage } from "../lib/api";

export function LoginPage() {
  const { user, signedIn, sessionExpired } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  const [users, setUsers] = useState<User[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    api
      .listUsers()
      .then((u) => !cancelled && setUsers(u))
      .catch((err: unknown) => !cancelled && setLoadError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (user) return <Navigate to={from} replace />;

  const choose = async (u: User) => {
    if (pendingId) return;
    setPendingId(u.id);
    setError(null);
    try {
      signedIn(await api.signIn(u.id));
      navigate(from, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setPendingId(null);
    }
  };

  return (
    <main className="login-page">
      <div className="login-card">
        <div className="brand brand-large">
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          <span className="brand-name">Ajaia Docs</span>
        </div>
        <h1 className="login-title">Sign in</h1>
        <p className="muted">
          This demo uses <strong>mocked sign-in</strong>: pick one of the seeded users. There is no password.
        </p>
        {sessionExpired ? (
          <p className="notice notice-warning" role="alert">
            Your session ended. Please sign in again.
          </p>
        ) : null}
        {error ? (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        ) : null}
        {loadError ? (
          <div className="notice notice-error" role="alert">
            <p>{loadError}</p>
            <button type="button" className="button" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        ) : users === null ? (
          <p className="muted">Loading users…</p>
        ) : (
          <ul className="user-list">
            {users.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  className="user-option"
                  onClick={() => void choose(u)}
                  disabled={pendingId !== null}
                  aria-busy={pendingId === u.id}
                >
                  <span className="avatar avatar-large" aria-hidden="true">
                    {u.name.slice(0, 1)}
                  </span>
                  <span className="user-option-text">
                    <span className="user-option-name">Continue as {u.name}</span>
                    <span className="user-option-email">{u.email}</span>
                  </span>
                  {pendingId === u.id ? <span className="spinner" aria-label="Signing in" /> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

export function LogoutPage() {
  const { signedOut } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    let cancelled = false;
    api
      .signOut()
      .catch(() => undefined) // the cookie is cleared server-side; offline logout still drops local state
      .finally(() => {
        if (cancelled) return;
        signedOut();
        navigate("/login", { replace: true });
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, signedOut]);
  return (
    <main className="center-page">
      <p className="muted">Signing out…</p>
    </main>
  );
}
