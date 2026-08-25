import { useEffect, useState } from "react";
import { api, getApiKey, getSessionToken } from "../api/client.js";
import Modal from "../components/Modal.js";
import type { QueueItem } from "../types.js";

interface ImportCandidate {
  path: string;
  size: number;
  mtimeMs: number;
}

interface TimelineEntry {
  timestamp: string;
  type: string;
  title: string;
  detail: string | null;
}

const TIMELINE_LABELS: Record<string, string> = {
  grabbed: "Grabbed",
  imported: "Imported",
  failed: "Failed",
  deleted: "Deleted",
  subtitleDownloaded: "Subtitle downloaded",
  auto_archived: "Auto-archived",
  requested: "Requested",
  request_approved: "Request approved",
  request_rejected: "Request rejected",
};

export default function Activity() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [retrying, setRetrying] = useState<number | null>(null);
  const [manualImportFor, setManualImportFor] = useState<QueueItem | null>(null);
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);

  function load() {
    api.get<QueueItem[]>("/activity/queue").then(setQueue);
    api.get<TimelineEntry[]>("/activity/timeline").then(setTimeline);
  }

  useEffect(() => {
    load();
    // 30s fallback poll — a safety net in case the SSE connection below never opens (e.g. a proxy
    // in front of AoNarr that buffers/blocks text/event-stream) or drops without EventSource's own
    // auto-reconnect kicking in for some reason. Real-time updates come from the "queue" event.
    const interval = setInterval(load, 30000);

    // /activity/stream is admin-only (same as every /activity route) and EventSource can't set the
    // X-Api-Key/X-Session-Token headers, so whichever credential this session actually has travels
    // as a query param instead — requireAuth accepts both as a fallback for exactly this case.
    let stream: EventSource | null = null;
    const apiKey = getApiKey();
    const sessionToken = getSessionToken();
    const authParam = apiKey ? `apikey=${encodeURIComponent(apiKey)}` : sessionToken ? `sessionToken=${encodeURIComponent(sessionToken)}` : null;
    if (authParam) {
      stream = new EventSource(`/api/activity/stream?${authParam}`);
      stream.addEventListener("queue", load);
    }

    return () => {
      clearInterval(interval);
      stream?.close();
    };
  }, []);

  async function remove(id: number) {
    await api.del(`/activity/queue/${id}`);
    load();
  }

  async function setPriority(id: number, priority: "top" | "normal") {
    try {
      await api.post(`/activity/queue/${id}/priority`, { priority });
      load();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function retryImport(id: number) {
    setRetrying(id);
    try {
      await api.post(`/activity/queue/${id}/retry-import`, {});
      load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setRetrying(null);
    }
  }

  function openManualImport(item: QueueItem) {
    setManualImportFor(item);
    setCandidates(null);
    setCandidatesError(null);
    api
      .get<ImportCandidate[]>(`/activity/queue/${item.id}/import-candidates`)
      .then(setCandidates)
      .catch((e) => setCandidatesError((e as Error).message));
  }

  async function manualImport(sourceFile: string) {
    if (!manualImportFor) return;
    setImporting(sourceFile);
    try {
      await api.post(`/activity/queue/${manualImportFor.id}/manual-import`, { sourceFile });
      setManualImportFor(null);
      load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setImporting(null);
    }
  }

  function formatSize(bytes: number): string {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    return `${(bytes / 1e3).toFixed(0)} KB`;
  }

  return (
    <div>
      <h1>Activity</h1>
      {queue.length === 0 && <p className="empty">Nothing in the queue.</p>}
      {queue.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Quality</th>
              <th>Size</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {queue.map((q) => (
              <tr key={q.id}>
                <td>
                  {q.title}
                  {q.retryCount > 0 && (
                    <span className="badge" style={{ marginLeft: 6 }} title="Auto-retried after an earlier release failed">
                      retry {q.retryCount}
                    </span>
                  )}
                </td>
                <td>
                  <span
                    className={`badge ${
                      q.status === "completed" || q.status === "imported"
                        ? "ok"
                        : q.status === "failed"
                        ? "danger"
                        : ""
                    }`}
                  >
                    {q.status}
                  </span>
                </td>
                <td>
                  <div className="progress-bar">
                    <div style={{ width: `${Math.round(q.progress * 100)}%` }} />
                  </div>
                </td>
                <td>{q.quality ?? "-"}</td>
                <td>{q.size ? `${(q.size / 1e9).toFixed(2)} GB` : "-"}</td>
                <td className="toolbar">
                  {(q.status === "queued" || q.status === "downloading") && (
                    <button className="secondary" onClick={() => setPriority(q.id, "top")}>
                      Prioritize
                    </button>
                  )}
                  {(q.status === "failed" || q.status === "completed") && (
                    <>
                      <button className="secondary" disabled={retrying === q.id} onClick={() => retryImport(q.id)}>
                        {retrying === q.id ? "Retrying..." : "Retry import"}
                      </button>
                      <button className="secondary" onClick={() => openManualImport(q)}>
                        Manual import...
                      </button>
                    </>
                  )}
                  <button className="danger" onClick={() => remove(q.id)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Timeline</h2>
      <p style={{ color: "var(--muted)" }}>
        Grabs, imports, failures, auto-archival, and request activity across every library, merged
        into one chronological feed.
      </p>
      {timeline.length === 0 && <p className="empty">Nothing has happened yet.</p>}
      {timeline.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Title</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {timeline.map((t, idx) => (
              <tr key={idx}>
                <td>{t.timestamp}</td>
                <td>
                  <span
                    className={`badge ${
                      t.type === "failed" || t.type === "request_rejected"
                        ? "danger"
                        : t.type === "imported" || t.type === "request_approved"
                        ? "ok"
                        : ""
                    }`}
                  >
                    {TIMELINE_LABELS[t.type] ?? t.type}
                  </span>
                </td>
                <td>{t.title}</td>
                <td>{t.detail ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {manualImportFor && (
        <Modal title={`Manual import — ${manualImportFor.title}`} onClose={() => setManualImportFor(null)} maxWidth={640}>
          <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
            Files found in the downloads directory matching this library's file types, newest
            first. Pick the one that's actually this download if AoNarr couldn't find or match it
            automatically.
          </p>
          {candidatesError && <p style={{ color: "var(--danger)" }}>{candidatesError}</p>}
          {candidates === null && !candidatesError && <p className="empty">Loading...</p>}
          {candidates !== null && candidates.length === 0 && (
            <p className="empty">No matching files found in the downloads directory.</p>
          )}
          {candidates !== null && candidates.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Path</th>
                  <th>Size</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => (
                  <tr key={c.path}>
                    <td style={{ fontFamily: "monospace", fontSize: "0.8rem", wordBreak: "break-all" }}>{c.path}</td>
                    <td>{formatSize(c.size)}</td>
                    <td>
                      <button disabled={importing === c.path} onClick={() => manualImport(c.path)}>
                        {importing === c.path ? "Importing..." : "Import"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      )}
    </div>
  );
}
