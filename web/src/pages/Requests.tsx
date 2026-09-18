import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api/client.js";
import { useAuth } from "../context/AuthContext.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import { useSortableTable } from "../hooks/useSortableTable.js";
import type { MediaRequest } from "../types.js";
import { CheckIcon, XIcon } from "../components/ActionIcons.js";
import { notify } from "../utils/notify.js";
import { confirmDialog } from "../utils/confirmDialog.js";

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
          await confirmDialog({
            title: "Already requested",
            message: `"${d.title}${d.year ? ` (${d.year})` : ""}" was already requested by ${d.username}. Submit another request for it anyway?`,
          })
        ) {
          await submitRequest(e, true);
        }
      } else {
        notify.error((err as Error).message);
      }
    }
  }

  async function approve(id: number, confirmDuplicate = false) {
    try {
      await api.post(`/requests/${id}/approve`, { confirmDuplicate });
      load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body?.duplicates?.length) {
        const names = err.body.duplicates.map((d: { title: string; year: number | null }) => `${d.title}${d.year ? ` (${d.year})` : ""}`).join(", ");
        if (await confirmDialog({ title: "Already in library", message: `Already in the library as: ${names}. Approve anyway and create a separate entry?` })) {
          await approve(id, true);
        }
      } else {
        notify.error((err as Error).message);
      }
    }
  }

  async function reject(id: number) {
    try {
      await api.post(`/requests/${id}/reject`, {});
      load();
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  async function cancel(id: number) {
    try {
      await api.del(`/requests/${id}`);
      load();
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  return (
    <div>
      <h1>Requests</h1>

      {!auth.isAdmin && (
        <form className="form-panel" onSubmit={submitRequest}>
          <label htmlFor="requests-library-1">Library</label>
          <select id="requests-library-1" value={type} onChange={(e) => setType(e.target.value)} required>
            <option value="">Select a library...</option>
            {allowedTypes.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
          <label htmlFor="requests-title-2">Title</label>
          <input id="requests-title-2" value={title} onChange={(e) => setTitle(e.target.value)} required />
          <label htmlFor="requests-year-optional-3">Year (optional)</label>
          <input id="requests-year-optional-3" value={year} onChange={(e) => setYear(e.target.value)} />
          <label htmlFor="requests-note-optional-4">Note (optional)</label>
          <input id="requests-note-optional-4" value={note} onChange={(e) => setNote(e.target.value)} />
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
      <RequestsTable requests={requests} labelFor={labelFor} isAdmin={auth.isAdmin} onApprove={approve} onReject={reject} onCancel={cancel} />
    </div>
  );
}

function RequestsTable({
  requests,
  labelFor,
  isAdmin,
  onApprove,
  onReject,
  onCancel,
}: {
  requests: MediaRequest[];
  labelFor: (key: string) => string;
  isAdmin: boolean;
  onApprove: (id: number) => void;
  onReject: (id: number) => void;
  onCancel: (id: number) => void;
}) {
  const { sortRows, sortableHeader } = useSortableTable<MediaRequest, "title" | "library" | "status" | "note">("title");
  const sorted = sortRows(requests, (a, b, key) => {
    if (key === "title") return a.title.localeCompare(b.title);
    if (key === "library") return labelFor(a.type).localeCompare(labelFor(b.type));
    if (key === "status") return a.status.localeCompare(b.status);
    return (a.note ?? "").localeCompare(b.note ?? "");
  });
  return (
    <table>
      <thead>
        <tr>
          {sortableHeader("title", "Title")}
          {sortableHeader("library", "Library")}
          {sortableHeader("status", "Status")}
          {sortableHeader("note", "Note")}
          <th></th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
            <tr key={r.id}>
              <td>
                {r.title} {r.year ? `(${r.year})` : ""}
              </td>
              <td>{labelFor(r.type)}</td>
              <td>{r.status}</td>
              <td>{r.note ?? "-"}</td>
              <td>
                {isAdmin && r.status === "pending" && (
                  <>
                    <button type="button" className="icon-button" onClick={() => onApprove(r.id)} title="Approve" aria-label="Approve">
                      <CheckIcon />
                    </button>
                    <button type="button" className="icon-button danger" onClick={() => onReject(r.id)} title="Reject" aria-label="Reject">
                      <XIcon />
                    </button>
                  </>
                )}
                {!isAdmin && r.status === "pending" && (
                  <button type="button" className="icon-button danger" onClick={() => onCancel(r.id)} title="Cancel" aria-label="Cancel">
                    <XIcon />
                  </button>
                )}
              </td>
            </tr>
        ))}
      </tbody>
    </table>
  );
}
