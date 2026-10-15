import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth";

/** Top bar: brand, optional page actions, signed-in user and sign-out. */
export function AppHeader({ children }: { children?: ReactNode }) {
  const { user } = useAuth();
  return (
    <header className="app-header">
      <Link to="/" className="brand" aria-label="Ajaia Docs home">
        <span className="brand-mark" aria-hidden="true">
          A
        </span>
        <span className="brand-name">Ajaia Docs</span>
      </Link>
      <div className="app-header-actions">{children}</div>
      {user ? (
        <div className="user-chip">
          <span className="avatar" aria-hidden="true">
            {user.name.slice(0, 1)}
          </span>
          <span className="user-name" title={`${user.email} (mocked sign-in)`}>
            {user.name}
          </span>
          <Link to="/logout" className="button button-ghost button-small">
            Sign out
          </Link>
        </div>
      ) : null}
    </header>
  );
}
