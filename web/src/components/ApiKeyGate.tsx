import { useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api/client.js";
import { hasCredentials, setApiKey, setSessionToken } from "../api/client.js";
import { AuthProvider } from "../context/AuthContext.js";

export default function ApiKeyGate({ children }: { children: ReactNode }) {
  const [hasCreds, setHasCreds] = useState(hasCredentials());
  const [mode, setMode] = useState<"admin" | "user">("admin");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [pendingTotpKey, setPendingTotpKey] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");

  async function submitAdmin(e: FormEvent) {
    e.preventDefault();
    const trimmed = apiKeyInput.trim();
    if (!trimmed) return;
    setChecking(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", { headers: { "X-Api-Key": trimmed } });
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Too many failed attempts. Try again later.");
      }
      if (!res.ok) throw new Error("Invalid API key");
      const settings = await res.json();
      if (settings.totpEnabled === "1") {
        setPendingTotpKey(trimmed);
      } else {
        setApiKey(trimmed);
        setHasCreds(true);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  }

  async function submitTotp(e: FormEvent) {
    e.preventDefault();
    if (!pendingTotpKey || totpCode.length !== 6) return;
    setChecking(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/totp/check-login", {
        method: "POST",
        headers: { "X-Api-Key": pendingTotpKey, "Content-Type": "application/json" },
        body: JSON.stringify({ code: totpCode }),
      });
      const body = await res.json();
      if (res.status === 429) throw new Error(body.error ?? "Too many failed attempts. Try again later.");
      if (!res.ok || !body.ok) throw new Error("Invalid code");
      setApiKey(pendingTotpKey);
      setHasCreds(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  }

  async function submitUser(e: FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setChecking(true);
    setError(null);
    try {
      const result = await api.post<{ token: string }>("/auth/login", { username: username.trim(), password });
      setSessionToken(result.token);
      setHasCreds(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  }

  if (hasCreds) return <AuthProvider>{children}</AuthProvider>;

  if (pendingTotpKey) {
    return (
      <div className="gate">
        <form className="form-panel" onSubmit={submitTotp} style={{ margin: "80px auto", maxWidth: 400 }}>
          <h1 style={{ color: "var(--accent)" }}>AoNarr</h1>
          <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
            Enter the 6-digit code from your authenticator app.
          </p>
          <label>Code</label>
          <input value={totpCode} onChange={(e) => setTotpCode(e.target.value)} maxLength={6} autoFocus />
          {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" disabled={checking}>
              {checking ? "Checking..." : "Continue"}
            </button>
            <button type="button" className="secondary" onClick={() => setPendingTotpKey(null)}>
              Back
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="gate">
      <form
        className="form-panel"
        onSubmit={mode === "admin" ? submitAdmin : submitUser}
        style={{ margin: "80px auto", maxWidth: 400 }}
      >
        <h1 style={{ color: "var(--accent)" }}>AoNarr</h1>

        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button type="button" className={mode === "admin" ? "" : "secondary"} onClick={() => setMode("admin")}>
            Admin
          </button>
          <button type="button" className={mode === "user" ? "" : "secondary"} onClick={() => setMode("user")}>
            Household login
          </button>
        </div>

        {mode === "admin" ? (
          <>
            <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
              Enter your API key to continue. On first run, find it in the container logs
              (<code>docker compose logs aonarr-server</code>) — it's printed once at startup.
            </p>
            <label>API key</label>
            <input value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} autoFocus />
          </>
        ) : (
          <>
            <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
              Sign in with the household account an admin created for you in Settings → Users.
            </p>
            <label>Username</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
            <label>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </>
        )}

        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
        <button type="submit" disabled={checking}>
          {checking ? "Checking..." : "Continue"}
        </button>
      </form>
    </div>
  );
}
