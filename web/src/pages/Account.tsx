import { useState } from "react";
import { api } from "../api/client.js";
import { useAuth } from "../context/AuthContext.js";

/** Self-service two-factor setup for the logged-in account — household or admin-via-session.
 * Reachable by everyone (unlike Settings, which is admin-only). */
export default function Account() {
  const { auth, refresh } = useAuth();
  const [totpSetup, setTotpSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const enabled = !!auth.user?.totpEnabled;
  const username = auth.isAdmin ? "admin" : auth.user?.username ?? "";

  async function startSetup() {
    setError(null);
    const result = await api.post<{ secret: string; otpauthUrl: string }>("/auth/totp/setup", {});
    setTotpSetup(result);
    setCode("");
  }

  async function confirmSetup() {
    setError(null);
    try {
      await api.post("/auth/totp/verify", { code });
      setTotpSetup(null);
      setCode("");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function disable() {
    setError(null);
    try {
      await api.post("/auth/totp/disable", { code: disableCode });
      setDisableCode("");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!auth.user) {
    return (
      <div>
        <h1>Account</h1>
        <p style={{ color: "var(--muted)" }}>
          Signed in via the instance API key — two-factor setup here applies to household/admin accounts. The
          API key's own TOTP option lives in Settings.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1>Account</h1>
      <p style={{ color: "var(--muted)" }}>Signed in as {username}</p>

      <h2>Two-factor authentication</h2>
      <div className="form-panel" style={{ maxWidth: 420 }}>
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
        {enabled ? (
          <>
            <p>Two-factor authentication is enabled on this account.</p>
            <label>Enter a code to disable it</label>
            <input value={disableCode} onChange={(e) => setDisableCode(e.target.value)} maxLength={6} />
            <button type="button" className="danger" onClick={disable}>
              Disable 2FA
            </button>
          </>
        ) : totpSetup ? (
          <>
            <p>Scan this into your authenticator app, or enter the secret manually.</p>
            <label>Secret</label>
            <input value={totpSetup.secret} readOnly />
            <label>otpauth URL</label>
            <input value={totpSetup.otpauthUrl} readOnly />
            <label>Enter the 6-digit code to confirm</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} maxLength={6} autoFocus />
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={confirmSetup}>
                Confirm and enable
              </button>
              <button type="button" className="secondary" onClick={() => setTotpSetup(null)}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <button type="button" onClick={startSetup}>
            Set up two-factor authentication
          </button>
        )}
      </div>
    </div>
  );
}
