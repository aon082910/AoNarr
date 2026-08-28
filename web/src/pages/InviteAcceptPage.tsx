import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { setSessionToken } from "../api/client.js";

interface InvitePreview {
  valid: true;
  allowedTypes: string[];
  role: string;
}

/** Fully public — no login, no API key. Reached by anyone with the /invite/:token link an admin
 * generated on the Users page. Mirrors SharePage.tsx's "outside ApiKeyGate" top-level route. */
export default function InviteAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch(`/api/invite/${token}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "This invite link isn't valid");
        setPreview(body);
      })
      .catch((err) => setError((err as Error).message));
  }, [token]);

  async function submit(e: FormEvent) {
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
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/invite/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Couldn't create your account");
      setSessionToken(body.token);
      setDone(true);
      window.location.href = "/";
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ maxWidth: 400, margin: "60px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ color: "#4f8cff" }}>AoNarr</h1>
      {error && <p style={{ color: "#e05c5c" }}>{error}</p>}
      {!preview && !error && <p>Loading...</p>}
      {preview && !done && (
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p>You've been invited to join this AoNarr instance. Choose a username and password to finish setting up your account.</p>
          <label>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
          <label>Confirm password</label>
          <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required minLength={8} />
          <button type="submit" disabled={submitting} style={{ marginTop: 8 }}>
            {submitting ? "Creating account..." : "Create account"}
          </button>
        </form>
      )}
      {done && <p>Account created — redirecting...</p>}
    </div>
  );
}
