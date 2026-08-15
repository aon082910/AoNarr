import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api/client.js";
import { useAuth } from "../context/AuthContext.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import type { MediaRequest } from "../types.js";

export default function Requests() {
  const { auth } = useAuth();
  const mediaTypes = useMediaTypes();
  const [requests, setRequests] = useState<MediaRequest[]>([]);
  const [type, setType] = useState("");
  const [title, setTitle] = useState("");
  const [year, setYear] = useState("");
  const [note, setNote] = useState("");

  const allowedTypes = auth.isAdmin ? mediaTypes : mediaTypes.filter((t) => auth.user?.allowedTypes.includes(t.key));
  const labelFor = (key: string) => mediaTypes.find((t) => t.key === key)?.label ?? key;

  function load() {
    api.get<MediaRequest[]>("/requests").then(setRequests);
  }
  useEffect(load, []);

  async function submitRequest(e: FormEvent, confirmDuplicate = false) {
    e.preventDefault();
    if (!type || !title.trim()) return;
    try {
      await api.post("/requests", {
        type,
        title: title.trim(),
        year: year ? Number(year) : null,
        note: note || null,
        confirmDuplicate,
      });
      setTitle("");
      setYear("");
      setNote("");
      load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body?.duplicate) {
        const d = err.body.duplicate;
        if (
          confirm(
            `"${d.title}${d.year ? ` (${d.year})` : ""}" was already requested by ${d.username}. Submit another request for it anyway?`
          )
        ) {
          await submitRequest(e, true);
        }
      } else {
        alert((err as Error).message);
      }
    }
  }

  async function approve(id: number) {
    await api.post(`/requests/${id}/approve`, {});
    load();
  }

  async function reject(id: number) {
    await api.post(`/requests/${id}/reject`, {});
    load();
  }

  async function cancel(id: number) {
    await api.del(`/requests/${id}`);
    load();
  }

  return (
    <div>
      <h1>Requests</h1>

      {!auth.isAdmin && (
        <form className="form-panel" onSubmit={submitRequest}>
          <label>Library</label>
          <select value={type} onChange={(e) => setType(e.target.value)} required>
            <option value="">Select a library...</option>
            {allowedTypes.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
          <label>Title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required />
          <label>Year (optional)</label>
          <input value={year} onChange={(e) => setYear(e.target.value)} />
          <label>Note (optional)</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
          <button type="submit">Submit request</button>
        </form>
      )}

      {!auth.isAdmin && requests.length > 0 && (
        <p style={{ color: "var(--muted)" }}>
          {requests.length} request(s) total ·{" "}
          {(() => {
            const approved = requests.filter((r) => r.status === "approved").length;
            const rejected = requests.filter((r) => r.status === "rejected").length;
            const resolved = approved + rejected;
            return resolved > 0 ? `${Math.round((approved / resolved) * 100)}% approval rate` : "none resolved yet";
          })()}
        </p>
      )}

      {requests.length === 0 && <p className="empty">No requests yet.</p>}
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Library</th>
            <th>Status</th>
            <th>Note</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id}>
              <td>
                {r.title} {r.year ? `(${r.year})` : ""}
              </td>
              <td>{labelFor(r.type)}</td>
              <td>{r.status}</td>
              <td>{r.note ?? "-"}</td>
              <td>
                {auth.isAdmin && r.status === "pending" && (
                  <>
                    <button onClick={() => approve(r.id)} style={{ marginRight: 6 }}>
                      Approve
                    </button>
                    <button className="danger" onClick={() => reject(r.id)}>
                      Reject
                    </button>
                  </>
                )}
                {!auth.isAdmin && r.status === "pending" && (
                  <button className="danger" onClick={() => cancel(r.id)}>
                    Cancel
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
