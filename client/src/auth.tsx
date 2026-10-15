import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { User } from "../../shared/api";
import { api, ApiError, UNAUTHORIZED_EVENT } from "./lib/api";

interface AuthState {
  /** undefined while the session probe is running. */
  user: User | null | undefined;
  /** True after a 401 kicked the user out (shown on the login screen). */
  sessionExpired: boolean;
  /** Set when the boot-time probe failed for a reason other than 401. */
  bootError: string | null;
  signedIn(user: User): void;
  signedOut(): void;
  retryBoot(): void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootAttempt, setBootAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setBootError(null);
    api
      .getSession()
      .then((u) => {
        if (!cancelled) setUser(u);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) setUser(null);
        else setBootError("Can't reach the server right now.");
      });
    return () => {
      cancelled = true;
    };
  }, [bootAttempt]);

  // EC-7: any 401 from any API call drops the session and routes to the login screen.
  useEffect(() => {
    const onUnauthorized = () => {
      setUser((current) => {
        if (current) setSessionExpired(true);
        return null;
      });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const signedIn = useCallback((u: User) => {
    setSessionExpired(false);
    setUser(u);
  }, []);
  const signedOut = useCallback(() => {
    setSessionExpired(false);
    setUser(null);
  }, []);
  const retryBoot = useCallback(() => setBootAttempt((n) => n + 1), []);

  const value = useMemo(
    () => ({ user, sessionExpired, bootError, signedIn, signedOut, retryBoot }),
    [user, sessionExpired, bootError, signedIn, signedOut, retryBoot],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
