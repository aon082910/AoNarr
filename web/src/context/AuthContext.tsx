import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, clearCredentials } from "../api/client.js";
import type { AuthMe } from "../types.js";

interface AuthContextValue {
  auth: AuthMe;
  refresh: () => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthMe | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const authRef = auth as AuthMe;

  async function refresh() {
    const me = await api.get<AuthMe>("/auth/me");
    setAuth(me);
  }

  // Everything renders behind this first /auth/me, so a failure other than 401 (which request()
  // already turns into a logout) — e.g. a 502 while the server container restarts — must keep
  // retrying and say so, or the whole app stays a blank page until the user reloads by hand.
  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const tryLoad = () => {
      api.get<AuthMe>("/auth/me").then(
        (me) => {
          if (cancelled) return;
          setAuth(me);
          setLoadError(null);
        },
        (e) => {
          if (cancelled) return;
          // A 401 is already mid-reload to the sign-in gate; it is not an unreachable server.
          if (!(e instanceof ApiError) && (e as Error)?.message === "Unauthorized") return;
          setLoadError((e as Error).message);
          retryTimer = setTimeout(tryLoad, Math.min(30_000, 2_000 * 2 ** attempt++));
        }
      );
    };
    tryLoad();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, [retryNonce]);

  function logout() {
    api.post("/auth/logout").catch(() => {});
    clearCredentials();
    window.location.reload();
  }

  if (!auth) {
    if (!loadError) return null;
    return (
      <div className="gate">
        <div className="form-panel" style={{ margin: "80px auto", maxWidth: 400 }}>
          <h1 style={{ color: "var(--accent)" }}>AoNarr</h1>
          <p>Can't reach the AoNarr server right now.</p>
          <p style={{ color: "var(--danger)" }}>{loadError}</p>
          <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>Retrying automatically...</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => setRetryNonce((n) => n + 1)}>
              Retry now
            </button>
            <button type="button" className="secondary" onClick={logout}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <AuthContext.Provider value={{ auth: authRef, refresh, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
