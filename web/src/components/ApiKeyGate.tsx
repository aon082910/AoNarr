import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api/client.js";
import { hasCredentials, setApiKey, setSessionToken } from "../api/client.js";
import { AuthProvider } from "../context/AuthContext.js";

type Mode = "admin" | "user" | "apikey";

export default function ApiKeyGate({ children }: { children: ReactNode }) {
  const [hasCreds, setHasCreds] = useState(hasCredentials());
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [mode, setMode] = useState<Mode>("admin");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [pendingTotpKey, setPendingTotpKey] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");

  useEffect(() => {
    if (hasCreds) return;
    fetch("/api/auth/setup-status")
      .then((res) => res.json())
      .then((body) => setNeedsSetup(!!body.needsSetup))
      .catch(() => setNeedsSetup(false));
  }, [hasCreds]);

  async function submitSetup(e: FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) return;
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match");
      return;
    }
    setChecking(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Setup failed");
      setSessionToken(body.token);
      setHasCreds(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  }

  async function submitApiKey(e: FormEvent) {
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

  async function submitLogin(e: FormEvent) {
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

  if (needsSetup === null) {
    return <div className="gate" />;
  }

  if (needsSetup) {
    return (
      <div className="gate">
        <form className="form-panel" onSubmit={submitSetup} style={{ margin: "80px auto", maxWidth: 400 }}>
          <h1 style={{ color: "var(--accent)" }}>AoNarr</h1>
          <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
            Create your admin account to finish setting up this instance.
          </p>
          <label>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <label>Confirm password</label>
          <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
          {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
          <button type="submit" disabled={checking}>
            {checking ? "Creating..." : "Create admin account"}
          </button>
        </form>
      </div>
    );
  }

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
        onSubmit={mode === "admin" ? submitLogin : mode === "user" ? submitLogin : submitApiKey}
        style={{ margin: "80px auto", maxWidth: 400 }}
      >
        <h1 style={{ color: "var(--accent)" }}>AoNarr</h1>

        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <button type="button" className={mode === "admin" ? "" : "secondary"} onClick={() => setMode("admin")}>
            Admin
          </button>
          <button type="button" className={mode === "user" ? "" : "secondary"} onClick={() => setMode("user")}>
            Household login
          </button>
          <button type="button" className={mode === "apikey" ? "" : "secondary"} onClick={() => setMode("apikey")}>
            API key
          </button>
        </div>

        {mode === "admin" && (
          <>
            <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>Sign in with your admin account.</p>
            <label>Username</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
            <label>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </>
        )}

        {mode === "user" && (
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

        {mode === "apikey" && (
          <>
            <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
              Legacy sign-in using the instance API key (Settings → General), for scripts/automation
              or accounts created before admin login existed.
            </p>
            <label>API key</label>
            <input value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} autoFocus />
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
