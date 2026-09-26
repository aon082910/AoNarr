import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, setSessionToken, uploadFormFile, useAvatarUrl } from "../api/client.js";
import { useAuth } from "../context/AuthContext.js";
import { notify } from "../utils/notify.js";
import { PencilIcon, TrashIcon } from "../components/ActionIcons.js";
import { GlobeIcon, PlusCircleIcon, UserIcon } from "../components/NavIcons.js";
import type { SocialLink, User } from "../types.js";

/** Self-service profile (photo, display name, bio, social links) plus two-factor setup for the
 * logged-in account — household or admin-via-session. Reachable by everyone (unlike Settings,
 * which is admin-only). Laid out as an actual full-page profile (banner + overlapping avatar +
 * centered identity block, Profile/Security tabs) rather than a settings-form box — the page
 * defaults to a read-only display view of the profile, with a pencil-icon "Edit profile" button
 * switching to the form fields. */
export default function Account() {
  const { auth, refresh } = useAuth();
  const [tab, setTab] = useState<"profile" | "security">("profile");
  const [editing, setEditing] = useState(false);

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
  // Bumped after every avatar upload so the new photo is fetched instead of the old one staying up.
  const [avatarVersion, setAvatarVersion] = useState(0);

  // Signed in with the API key on an instance that has no admin account yet (an install from before
  // admin login existed, or one set up headless): the login screen's own setup form is only offered
  // to a brand-new install, so this is where that first account gets created.
  const [needsAdminAccount, setNeedsAdminAccount] = useState(false);
  const [adminUsername, setAdminUsername] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminConfirmPassword, setAdminConfirmPassword] = useState("");
  const [adminError, setAdminError] = useState<string | null>(null);
  const [creatingAdmin, setCreatingAdmin] = useState(false);

  useEffect(() => {
    if (auth.user || !auth.isAdmin) return;
    api
      .get<User[]>("/users")
      .then((users) => setNeedsAdminAccount(!users.some((u) => u.role === "admin")))
      .catch(() => setNeedsAdminAccount(false));
  }, [auth.user, auth.isAdmin]);

  async function createAdminAccount(e: FormEvent) {
    e.preventDefault();
    if (!adminUsername.trim() || !adminPassword) return;
    if (adminPassword.length < 8) {
      setAdminError("Password must be at least 8 characters");
      return;
    }
    if (adminPassword !== adminConfirmPassword) {
      setAdminError("Passwords don't match");
      return;
    }
    setCreatingAdmin(true);
    setAdminError(null);
    try {
      const result = await api.post<{ token: string }>("/auth/setup", { username: adminUsername.trim(), password: adminPassword });
      setSessionToken(result.token);
      window.location.reload();
    } catch (err) {
      setAdminError((err as Error).message);
    } finally {
      setCreatingAdmin(false);
    }
  }

  const enabled = !!auth.user?.totpEnabled;
  const username = auth.user?.username ?? "";
  const currentAvatarUrl = useAvatarUrl(auth.user?.id, !!auth.user?.avatarPath, avatarVersion);

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

  function startEditing() {
    setDisplayName(auth.user?.displayName ?? "");
    setBio(auth.user?.bio ?? "");
    setSocialLinks(auth.user?.socialLinks ?? []);
    setEditing(true);
  }

  async function saveProfile() {
    setSavingProfile(true);
    try {
      await api.patch("/auth/me", { displayName, bio, socialLinks });
      await refresh();
      notify.success("Profile saved.");
      setEditing(false);
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
        {needsAdminAccount && (
          <form className="form-panel" onSubmit={createAdminAccount} style={{ maxWidth: 420 }}>
            <h2 style={{ marginTop: 0 }}>Create an admin account</h2>
            <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
              This instance has no admin account yet. Create one to sign in with a username and
              password — the API key keeps working for scripts and integrations.
            </p>
            <label htmlFor="account-admin-username">Username</label>
            <input id="account-admin-username" value={adminUsername} onChange={(e) => setAdminUsername(e.target.value)} />
            <label htmlFor="account-admin-password">Password</label>
            <input id="account-admin-password" type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} />
            <label htmlFor="account-admin-confirm-password">Confirm password</label>
            <input
              id="account-admin-confirm-password"
              type="password"
              value={adminConfirmPassword}
              onChange={(e) => setAdminConfirmPassword(e.target.value)}
            />
            {adminError && <p style={{ color: "var(--danger)" }}>{adminError}</p>}
            <button type="submit" disabled={creatingAdmin}>
              {creatingAdmin ? "Creating..." : "Create admin account"}
            </button>
          </form>
        )}
      </div>
    );
  }

  const savedSocialLinks = auth.user.socialLinks ?? [];
  const savedBio = auth.user.bio ?? "";

  return (
    <div>
      <div
        className="media-backdrop"
        style={{ height: 80, backgroundImage: "linear-gradient(135deg, var(--accent-dim), var(--border))" }}
      />
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: -56, marginBottom: 16 }}>
        <div
          style={{
            width: 112,
            height: 112,
            borderRadius: "50%",
            overflow: "hidden",
            flexShrink: 0,
            background: "var(--input-bg)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "4px solid var(--bg)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          }}
        >
          {currentAvatarUrl ? (
            <img src={currentAvatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <UserIcon />
          )}
        </div>
        <h1 style={{ margin: "10px 0 0" }}>{auth.user.displayName || username}</h1>
        <p style={{ margin: "2px 0 0", color: "var(--muted)" }}>@{username}</p>
        {!editing && savedBio && <p style={{ margin: "8px 0 0", textAlign: "center", maxWidth: 480 }}>{savedBio}</p>}
        {!editing && savedSocialLinks.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 14, marginTop: 8 }}>
            {savedSocialLinks.map((link, idx) => (
              <a key={idx} href={link.url} target="_blank" rel="noreferrer" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "0.85rem" }}>
                <GlobeIcon /> {link.label || link.url}
              </a>
            ))}
          </div>
        )}
        {!editing && (
          <button type="button" className="secondary" onClick={startEditing} style={{ marginTop: 12, width: "auto" }}>
            <PencilIcon /> Edit profile
          </button>
        )}
      </div>

      <div className="settings-tabs" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
        {(
          [
            ["profile", "Profile"],
            ["security", "Security"],
          ] as const
        ).map(([key, label]) => (
          <button key={key} type="button" className={tab === key ? "" : "secondary"} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      <div style={{ display: tab === "profile" ? undefined : "none" }}>
        {editing ? (
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
                  <img src={currentAvatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
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

            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={saveProfile} disabled={savingProfile}>
                {savingProfile ? "Saving..." : "Save profile"}
              </button>
              <button type="button" className="secondary" onClick={() => setEditing(false)} disabled={savingProfile}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          !savedBio &&
          savedSocialLinks.length === 0 && <p className="empty">No bio or links yet — click "Edit profile" to add some.</p>
        )}
      </div>

      <div style={{ display: tab === "security" ? undefined : "none" }}>
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
    </div>
  );
}
