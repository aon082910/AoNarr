import { useRef, useState } from "react";
import { api, avatarUrl, uploadFormFile } from "../api/client.js";
import { useAuth } from "../context/AuthContext.js";
import { notify } from "../utils/notify.js";
import { TrashIcon } from "../components/ActionIcons.js";
import { PlusCircleIcon, UserIcon } from "../components/NavIcons.js";
import type { SocialLink } from "../types.js";

/** Self-service profile (photo, display name, bio, social links) plus two-factor setup for the
 * logged-in account — household or admin-via-session. Reachable by everyone (unlike Settings,
 * which is admin-only). */
export default function Account() {
  const { auth, refresh } = useAuth();
  const [totpSetup, setTotpSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState(auth.user?.displayName ?? "");
  const [bio, setBio] = useState(auth.user?.bio ?? "");
  const [socialLinks, setSocialLinks] = useState<SocialLink[]>(auth.user?.socialLinks ?? []);
  const [savingProfile, setSavingProfile] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  // Bumped after every avatar upload so the <img> URL changes and the browser doesn't keep showing
  // a cached copy of the old photo at the same URL.
  const [avatarVersion, setAvatarVersion] = useState(0);

  const enabled = !!auth.user?.totpEnabled;
  const username = auth.isAdmin ? "admin" : auth.user?.username ?? "";

  async function startSetup() {
    setError(null);
    try {
      const result = await api.post<{ secret: string; otpauthUrl: string }>("/auth/totp/setup", {});
      setTotpSetup(result);
      setCode("");
    } catch (err) {
      setError((err as Error).message);
    }
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

  async function saveProfile() {
    setSavingProfile(true);
    try {
      await api.patch("/auth/me", { displayName, bio, socialLinks });
      await refresh();
      notify.success("Profile saved.");
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setSavingProfile(false);
    }
  }

  async function uploadAvatar(file: File) {
    setUploadingAvatar(true);
    try {
      await uploadFormFile("/auth/me/avatar", file);
      await refresh();
      setAvatarVersion((v) => v + 1);
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setUploadingAvatar(false);
      if (avatarInputRef.current) avatarInputRef.current.value = "";
    }
  }

  function updateLink(idx: number, field: "label" | "url", value: string) {
    setSocialLinks((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));
  }

  function removeLink(idx: number) {
    setSocialLinks((prev) => prev.filter((_, i) => i !== idx));
  }

  if (!auth.user) {
    return (
      <div>
        <h1>Account</h1>
        <p style={{ color: "var(--muted)" }}>
          Signed in via the instance API key — profile and two-factor setup here apply to
          household/admin accounts. The API key's own TOTP option lives in Settings.
        </p>
      </div>
    );
  }

  const currentAvatarUrl = auth.user.avatarPath ? avatarUrl(auth.user.id) : null;

  return (
    <div>
      <h1>Account</h1>
      <p style={{ color: "var(--muted)" }}>Signed in as {username}</p>

      <h2>Profile</h2>
      <div className="form-panel" style={{ maxWidth: 480 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: "50%",
              overflow: "hidden",
              flexShrink: 0,
              background: "var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {currentAvatarUrl ? (
              <img key={avatarVersion} src={`${currentAvatarUrl}${currentAvatarUrl.includes("?") ? "&" : "?"}v=${avatarVersion}`} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <UserIcon />
            )}
          </div>
          <div>
            <button type="button" className="secondary" onClick={() => avatarInputRef.current?.click()} disabled={uploadingAvatar}>
              {uploadingAvatar ? "Uploading..." : "Change photo"}
            </button>
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              style={{ display: "none" }}
              onChange={(e) => e.target.files?.[0] && uploadAvatar(e.target.files[0])}
            />
          </div>
        </div>

        <label htmlFor="account-display-name">Display name</label>
        <input id="account-display-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={username} />

        <label htmlFor="account-bio">Bio</label>
        <textarea id="account-bio" value={bio} onChange={(e) => setBio(e.target.value)} rows={3} placeholder="A little about you" />

        <label>Links</label>
        {socialLinks.map((link, idx) => (
          <div key={idx} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <input
              value={link.label}
              onChange={(e) => updateLink(idx, "label", e.target.value)}
              placeholder="Label (e.g. GitHub)"
              style={{ maxWidth: 160 }}
            />
            <input value={link.url} onChange={(e) => updateLink(idx, "url", e.target.value)} placeholder="https://..." />
            <button type="button" className="icon-button" onClick={() => removeLink(idx)} title="Remove link" aria-label="Remove link">
              <TrashIcon />
            </button>
          </div>
        ))}
        <button type="button" className="secondary" onClick={() => setSocialLinks((prev) => [...prev, { label: "", url: "" }])} style={{ marginBottom: 12 }}>
          <PlusCircleIcon /> Add link
        </button>

        <div>
          <button type="button" onClick={saveProfile} disabled={savingProfile}>
            {savingProfile ? "Saving..." : "Save profile"}
          </button>
        </div>
      </div>

      <h2>Two-factor authentication</h2>
      <div className="form-panel" style={{ maxWidth: 420 }}>
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
        {enabled ? (
          <>
            <p>Two-factor authentication is enabled on this account.</p>
            <label htmlFor="account-enter-a-code-to-disable-it-1">Enter a code to disable it</label>
            <input id="account-enter-a-code-to-disable-it-1" value={disableCode} onChange={(e) => setDisableCode(e.target.value)} maxLength={6} />
            <button type="button" className="danger" onClick={disable}>
              Disable 2FA
            </button>
          </>
        ) : totpSetup ? (
          <>
            <p>Scan this into your authenticator app, or enter the secret manually.</p>
            <label htmlFor="account-secret-2">Secret</label>
            <input id="account-secret-2" value={totpSetup.secret} readOnly />
            <label htmlFor="account-otpauth-url-3">otpauth URL</label>
            <input id="account-otpauth-url-3" value={totpSetup.otpauthUrl} readOnly />
            <label htmlFor="account-enter-the-6-digit-code-to-confirm-4">Enter the 6-digit code to confirm</label>
            <input id="account-enter-the-6-digit-code-to-confirm-4" value={code} onChange={(e) => setCode(e.target.value)} maxLength={6} autoFocus />
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
