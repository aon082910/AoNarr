import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client.js";
import Modal from "../components/Modal.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import { useContentRatings } from "../hooks/useContentRatings.js";
import type { RequestStats, Session, User } from "../types.js";
import { formatBytes } from "../utils/format.js";

export default function Users() {
  const mediaTypes = useMediaTypes();
  const contentRatings = useContentRatings();
  const [users, setUsers] = useState<User[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [allowedTypes, setAllowedTypes] = useState<string[]>([]);
  const [maxPendingRequests, setMaxPendingRequests] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const [maxContentRating, setMaxContentRating] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [requestStats, setRequestStats] = useState<RequestStats[]>([]);

  function load() {
    api.get<User[]>("/users").then(setUsers);
    api.get<Session[]>("/users/sessions").then(setSessions);
    api.get<RequestStats[]>("/requests/stats").then(setRequestStats);
  }
  useEffect(load, []);

  async function revokeSession(token: string) {
    await api.del(`/users/sessions/${token}`);
    setSessions((prev) => prev.filter((s) => s.token !== token));
  }

  function toggleType(key: string) {
    setAllowedTypes((prev) => (prev.includes(key) ? prev.filter((t) => t !== key) : [...prev, key]));
  }

  async function addUser(e: FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) return;
    await api.post("/users", {
      username: username.trim(),
      password,
      allowedTypes,
      maxPendingRequests: maxPendingRequests ? Number(maxPendingRequests) : null,
      autoApprove,
      maxContentRating: maxContentRating || null,
    });
    setUsername("");
    setPassword("");
    setAllowedTypes([]);
    setMaxPendingRequests("");
    setAutoApprove(false);
    setMaxContentRating("");
    setShowAdd(false);
    load();
  }

  async function updateAccess(user: User, key: string) {
    const next = user.allowedTypes.includes(key)
      ? user.allowedTypes.filter((t) => t !== key)
      : [...user.allowedTypes, key];
    await api.patch(`/users/${user.id}`, { allowedTypes: next });
    load();
  }

  async function updateMaxPendingRequests(user: User, value: string) {
    await api.patch(`/users/${user.id}`, { maxPendingRequests: value ? Number(value) : null });
    load();
  }

  async function updateAutoApprove(user: User, value: boolean) {
    await api.patch(`/users/${user.id}`, { autoApprove: value });
    load();
  }

  async function updateMaxContentRating(user: User, value: string) {
    await api.patch(`/users/${user.id}`, { maxContentRating: value || null });
    load();
  }

  async function removeUser(id: number) {
    if (!confirm("Delete this user account? This cannot be undone.")) return;
    await api.del(`/users/${id}`);
    load();
  }

  async function resetPassword(user: User) {
    const newPassword = prompt(`New password for ${user.username} (min 8 characters):`);
    if (!newPassword) return;
    if (newPassword.length < 8) {
      alert("Password must be at least 8 characters.");
      return;
    }
    await api.patch(`/users/${user.id}`, { password: newPassword });
    alert(`Password reset for ${user.username}. Their other active sessions have been logged out.`);
    load();
  }

  return (
    <div>
      <h1>Users</h1>
      <p style={{ color: "var(--muted)" }}>
        Household accounts get read-only, per-library browsing plus the ability to submit requests — they
        never see Settings, Indexers, or other admin pages. Max pending requests limits how many
        requests can sit unresolved at once; auto-approve skips the review queue entirely and adds
        the item to the library immediately on request.
      </p>

      <button type="button" onClick={() => setShowAdd(true)} style={{ marginBottom: 16 }}>
        + Add user
      </button>

      {showAdd && (
        <Modal title="Add User" onClose={() => setShowAdd(false)}>
      <form className="form-panel" onSubmit={addUser} style={{ padding: 0 }}>
        <label>Username</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} required />
        <label>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <label>Library access</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
          {mediaTypes.map((t) => (
            <label key={t.key} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type="checkbox" checked={allowedTypes.includes(t.key)} onChange={() => toggleType(t.key)} />
              {t.label}
            </label>
          ))}
        </div>
        <label>Max pending requests (blank = unlimited)</label>
        <input
          type="number"
          style={{ maxWidth: 120 }}
          value={maxPendingRequests}
          onChange={(e) => setMaxPendingRequests(e.target.value)}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
          Auto-approve this user's requests
        </label>
        <label>Max content rating (blank = no restriction)</label>
        <select value={maxContentRating} onChange={(e) => setMaxContentRating(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="">No restriction</option>
          {contentRatings.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button type="submit">Create user</button>
      </form>
        </Modal>
      )}

      {users.length === 0 && <p className="empty">No household accounts yet.</p>}
      <table>
        <thead>
          <tr>
            <th>Username</th>
            <th>Library access</th>
            <th>Max pending</th>
            <th>Auto-approve</th>
            <th>Max content rating</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.username}</td>
              <td>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {mediaTypes.map((t) => (
                    <label key={t.key} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <input
                        type="checkbox"
                        checked={u.allowedTypes.includes(t.key)}
                        onChange={() => updateAccess(u, t.key)}
                      />
                      {t.label}
                    </label>
                  ))}
                </div>
              </td>
              <td>
                <input
                  type="number"
                  style={{ width: 80 }}
                  defaultValue={u.maxPendingRequests ?? ""}
                  placeholder="∞"
                  onBlur={(e) => updateMaxPendingRequests(u, e.target.value)}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={!!u.autoApprove}
                  onChange={(e) => updateAutoApprove(u, e.target.checked)}
                />
              </td>
              <td>
                <select
                  defaultValue={u.maxContentRating ?? ""}
                  onChange={(e) => updateMaxContentRating(u, e.target.value)}
                  style={{ maxWidth: 160 }}
                >
                  <option value="">No restriction</option>
                  {contentRatings.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <button className="secondary" style={{ marginRight: 6 }} onClick={() => resetPassword(u)}>
                  Reset password
                </button>
                <button className="danger" onClick={() => removeUser(u.id)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginTop: 24 }}>Active sessions</h2>
      <p style={{ color: "var(--muted)" }}>
        Every household account currently logged in on a browser or device. Revoking a session logs that
        device out immediately.
      </p>
      {sessions.length === 0 && <p className="empty">No active sessions.</p>}
      {sessions.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Last active</th>
              <th>Signed in</th>
              <th>Device</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.token}>
                <td>{s.username}</td>
                <td>{s.lastUsedAt ? new Date(s.lastUsedAt).toLocaleString() : "-"}</td>
                <td>{new Date(s.createdAt).toLocaleString()}</td>
                <td style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.userAgent ?? "unknown"}
                </td>
                <td>
                  <button className="danger" onClick={() => revokeSession(s.token)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={{ marginTop: 24 }}>Request stats</h2>
      <p style={{ color: "var(--muted)" }}>
        How much each household account requests, and how much of the library it's responsible for
        — storage is computed from the actual files on disk for their approved requests.
      </p>
      {requestStats.length === 0 && <p className="empty">No request activity yet.</p>}
      {requestStats.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Total</th>
              <th>Pending</th>
              <th>Approved</th>
              <th>Rejected</th>
              <th>Approval rate</th>
              <th>Storage</th>
            </tr>
          </thead>
          <tbody>
            {requestStats.map((s) => (
              <tr key={s.userId}>
                <td>{s.username}</td>
                <td>{s.totalRequests}</td>
                <td>{s.pending}</td>
                <td>{s.approved}</td>
                <td>{s.rejected}</td>
                <td>{s.approvalRatePercent === null ? "-" : `${s.approvalRatePercent}%`}</td>
                <td>{formatBytes(s.storageBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
