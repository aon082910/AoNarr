import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client.js";
import Modal from "../components/Modal.js";
import SettingsSectionTiles from "../components/SettingsSectionTiles.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import { useContentRatings } from "../hooks/useContentRatings.js";
import type { RequestStats, Session, User } from "../types.js";
import { formatBytes } from "../utils/format.js";

export default function Users() {
  const mediaTypes = useMediaTypes();
  const contentRatings = useContentRatings();
  const [users, setUsers] = useState<User[]>([]);
  const [mode, setMode] = useState<"add" | number | null>(null);
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

  function resetForm() {
    setUsername("");
    setPassword("");
    setAllowedTypes([]);
    setMaxPendingRequests("");
    setAutoApprove(false);
    setMaxContentRating("");
  }

  function openAdd() {
    resetForm();
    setMode("add");
  }

  function openEdit(u: User) {
    setUsername(u.username);
    setPassword("");
    setAllowedTypes(u.allowedTypes);
    setMaxPendingRequests(u.maxPendingRequests != null ? String(u.maxPendingRequests) : "");
    setAutoApprove(!!u.autoApprove);
    setMaxContentRating(u.maxContentRating ?? "");
    setMode(u.id);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!username.trim() || (mode === "add" && !password)) return;
    const body = {
      username: username.trim(),
      allowedTypes,
      maxPendingRequests: maxPendingRequests ? Number(maxPendingRequests) : null,
      autoApprove,
      maxContentRating: maxContentRating || null,
      ...(password ? { password } : {}),
    };
    if (mode === "add") {
      await api.post("/users", body);
    } else if (typeof mode === "number") {
      await api.patch(`/users/${mode}`, body);
    }
    setMode(null);
    load();
  }

  async function removeUser(id: number) {
    if (!confirm("Delete this user account? This cannot be undone.")) return;
    await api.del(`/users/${id}`);
    setMode(null);
    load();
  }

  const editingUser = typeof mode === "number" ? users.find((u) => u.id === mode) ?? null : null;

  return (
    <div>
      <h1>Users</h1>
      <p style={{ color: "var(--muted)" }}>
        Household accounts get read-only, per-library browsing plus the ability to submit requests — they
        never see Settings, Indexers, or other admin pages. Max pending requests limits how many
        requests can sit unresolved at once; auto-approve skips the review queue entirely and adds
        the item to the library immediately on request. Click a tile to edit that user.
      </p>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", marginBottom: 16 }}>
        <div className="card" onClick={openAdd} style={{ padding: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ fontWeight: 600 }}>+ Add user</div>
        </div>
        {users.map((u) => (
          <div key={u.id} className="card" onClick={() => openEdit(u)} style={{ padding: 16 }}>
            <div style={{ fontWeight: 600 }}>{u.username}</div>
            <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: 4 }}>
              {u.allowedTypes.length === 0 ? "no library access" : `${u.allowedTypes.length} librar${u.allowedTypes.length === 1 ? "y" : "ies"}`}
            </div>
            {!!u.autoApprove && (
              <span className="badge ok" style={{ marginTop: 8, display: "inline-block" }}>
                Auto-approve
              </span>
            )}
          </div>
        ))}
      </div>
      {users.length === 0 && <p className="empty">No household accounts yet.</p>}

      {mode !== null && (mode === "add" || editingUser) && (
        <Modal title={mode === "add" ? "Add User" : `Edit — ${editingUser!.username}`} onClose={() => setMode(null)}>
          <form className="form-panel" onSubmit={submit} style={{ padding: 0 }}>
            <label>Username</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} required />
            <label>Password{mode !== "add" && " (leave blank to keep current)"}</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required={mode === "add"} />
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
            <div className="toolbar" style={{ justifyContent: "space-between", marginTop: 8 }}>
              <button type="submit">{mode === "add" ? "Create user" : "Save"}</button>
              {mode !== "add" && (
                <button type="button" className="danger" onClick={() => removeUser(mode as number)}>
                  Delete
                </button>
              )}
            </div>
          </form>
        </Modal>
      )}

      <SettingsSectionTiles
        sections={[
          {
            key: "sessions",
            label: "Active Sessions",
            description: "Every household account currently logged in",
            badge: `${sessions.length} session${sessions.length === 1 ? "" : "s"}`,
            badgeOk: sessions.length > 0,
            maxWidth: 780,
            render: () => (
              <div>
                <p style={{ color: "var(--muted)", marginTop: 0 }}>
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
              </div>
            ),
          },
          {
            key: "requestStats",
            label: "Request Stats",
            description: "How much each account requests and stores",
            maxWidth: 780,
            render: () => (
              <div>
                <p style={{ color: "var(--muted)", marginTop: 0 }}>
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
            ),
          },
        ]}
      />
    </div>
  );
}
