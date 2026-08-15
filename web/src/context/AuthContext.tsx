import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, clearCredentials } from "../api/client.js";
import type { AuthMe } from "../types.js";

interface AuthContextValue {
  auth: AuthMe;
  refresh: () => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthMe | null>(null);
  const authRef = auth as AuthMe;

  async function refresh() {
    const me = await api.get<AuthMe>("/auth/me");
    setAuth(me);
  }

  useEffect(() => {
    refresh();
  }, []);

  function logout() {
    api.post("/auth/logout").catch(() => {});
    clearCredentials();
    window.location.reload();
  }

  if (!auth) return null;

  return <AuthContext.Provider value={{ auth: authRef, refresh, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
