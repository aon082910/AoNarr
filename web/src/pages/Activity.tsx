import { useEffect, useMemo, useRef, useState } from "react";
import { api, getApiKey, getSessionToken } from "../api/client.js";
import Modal from "../components/Modal.js";
import type { QueueItem, Quality } from "../types.js";

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

type QueueStatusFilter = "all" | "queued" | "downloading" | "failed";
type QueueSortKey = "title" | "status" | "progress" | "size";
type HistorySortDir = "desc" | "asc";

const QUEUE_STATUS_OPTIONS: { value: QueueStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "downloading", label: "Downloading" },
  { value: "queued", label: "Queued" },
  { value: "failed", label: "Failed" },
];

export default function Activity() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [retrying, setRetrying] = useState<number | null>(null);
  const [manualImportFor, setManualImportFor] = useState<QueueItem | null>(null);
  const [qualities, setQualities] = useState<Quality[]>([]);
  const [overrideQuality, setOverrideQuality] = useState("");
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);

  const [queueStatusFilter, setQueueStatusFilter] = useState<QueueStatusFilter>(
    () => (localStorage.getItem("aonarr_activity_queue_status") as QueueStatusFilter) || "all"
  );
  const [queueSortKey, setQueueSortKey] = useState<QueueSortKey>("status");
  const [queueSortDir, setQueueSortDir] = useState<HistorySortDir>("desc");

  const [historyTypeFilter, setHistoryTypeFilter] = useState<string>(
    () => localStorage.getItem("aonarr_activity_history_type") || "all"
  );
  const [historySearch, setHistorySearch] = useState("");
  const [historySortDir, setHistorySortDir] = useState<HistorySortDir>("desc");

  useEffect(() => {
    localStorage.setItem("aonarr_activity_queue_status", queueStatusFilter);
  }, [queueStatusFilter]);

  useEffect(() => {
    localStorage.setItem("aonarr_activity_history_type", historyTypeFilter);
  }, [historyTypeFilter]);

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
    // as a query param instead — requireAuth already accepts both as a fallback for exactly this case.
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

  async function remove(id: number, blocklist = false) {
    await api.del(`/activity/queue/${id}${blocklist ? "?blocklist=1" : ""}`);
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

  // Guards against opening manual-import for one queue item, then quickly for another before the
  // first's candidate list has loaded — without this, a slow response for the first request could
  // land after the second and overwrite its (correctly labeled) modal with the first item's files.
  const manualImportRequestRef = useRef(0);
  function openManualImport(item: QueueItem) {
    const requestId = ++manualImportRequestRef.current;
    setManualImportFor(item);
    setCandidates(null);
    setCandidatesError(null);
    setOverrideQuality("");
    if (qualities.length === 0) api.get<Quality[]>("/qualities").then(setQualities);
    api
      .get<ImportCandidate[]>(`/activity/queue/${item.id}/import-candidates`)
      .then((c) => {
        if (manualImportRequestRef.current === requestId) setCandidates(c);
      })
      .catch((e) => {
        if (manualImportRequestRef.current === requestId) setCandidatesError((e as Error).message);
      });
  }

  async function manualImport(sourceFile: string) {
    if (!manualImportFor) return;
    setImporting(sourceFile);
    try {
      await api.post(`/activity/queue/${manualImportFor.id}/manual-import`, { sourceFile, quality: overrideQuality || undefined });
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

  function toggleQueueSort(key: QueueSortKey) {
    if (queueSortKey === key) {
      setQueueSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setQueueSortKey(key);
      setQueueSortDir("asc");
    }
  }

  const QUEUE_STATUS_RANK: Record<string, number> = { downloading: 0, importing: 1, queued: 2, failed: 3, completed: 4, imported: 5 };

  const visibleQueue = useMemo(() => {
    const filtered = queueStatusFilter === "all" ? queue : queue.filter((q) => q.status === queueStatusFilter);
    const sorted = [...filtered].sort((a, b) => {
      let cmp = 0;
      if (queueSortKey === "title") cmp = a.title.localeCompare(b.title);
      else if (queueSortKey === "status") cmp = (QUEUE_STATUS_RANK[a.status] ?? 9) - (QUEUE_STATUS_RANK[b.status] ?? 9);
      else if (queueSortKey === "progress") cmp = a.progress - b.progress;
      else if (queueSortKey === "size") cmp = (a.size ?? 0) - (b.size ?? 0);
      return queueSortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [queue, queueStatusFilter, queueSortKey, queueSortDir]);

  const historyTypes = useMemo(() => Array.from(new Set(timeline.map((t) => t.type))).sort(), [timeline]);

  const visibleHistory = useMemo(() => {
    const needle = historySearch.trim().toLowerCase();
    let filtered = timeline;
    if (historyTypeFilter !== "all") filtered = filtered.filter((t) => t.type === historyTypeFilter);
    if (needle) {
      filtered = filtered.filter(
        (t) => t.title.toLowerCase().includes(needle) || (t.detail ?? "").toLowerCase().includes(needle)
      );
    }
    const sorted = [...filtered].sort((a, b) => {
      const cmp = a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;
      return historySortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [timeline, historyTypeFilter, historySearch, historySortDir]);

  function sortIndicator(active: boolean, dir: HistorySortDir) {
    if (!active) return null;
    return <span style={{ marginLeft: 4, opacity: 0.7 }}>{dir === "asc" ? "▲" : "▼"}</span>;
  }

  return (
    <div>
      <h1>Activity</h1>

      <h2 style={{ marginBottom: 4 }}>Queue</h2>
      <div className="toolbar" style={{ marginBottom: 10, gap: 8 }}>
        <select value={queueStatusFilter} onChange={(e) => setQueueStatusFilter(e.target.value as QueueStatusFilter)} style={{ maxWidth: 180 }}>
          {QUEUE_STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button className="secondary" onClick={load}>
          Refresh
        </button>
        <span style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
          {visibleQueue.length} of {queue.length}
        </span>
      </div>
      {queue.length === 0 && <p className="empty">Nothing in the queue.</p>}
      {queue.length > 0 && visibleQueue.length === 0 && <p className="empty">No queue items match this filter.</p>}
      {visibleQueue.length > 0 && (
        <table>
          <thead>
            <tr>
              <th style={{ cursor: "pointer" }} onClick={() => toggleQueueSort("title")}>
                Title{sortIndicator(queueSortKey === "title", queueSortDir)}
              </th>
              <th style={{ cursor: "pointer" }} onClick={() => toggleQueueSort("status")}>
                Status{sortIndicator(queueSortKey === "status", queueSortDir)}
              </th>
              <th style={{ cursor: "pointer" }} onClick={() => toggleQueueSort("progress")}>
                Progress{sortIndicator(queueSortKey === "progress", queueSortDir)}
              </th>
              <th>Quality</th>
              <th style={{ cursor: "pointer" }} onClick={() => toggleQueueSort("size")}>
                Size{sortIndicator(queueSortKey === "size", queueSortDir)}
              </th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visibleQueue.map((q) => (
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
                  <button className="danger" onClick={() => remove(q.id, true)}>
                    Remove &amp; Blocklist
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={{ marginBottom: 4, marginTop: 32 }}>History</h2>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>
        Grabs, imports, failures, auto-archival, and request activity across every library, merged
        into one chronological feed.
      </p>
      <div className="toolbar" style={{ marginBottom: 10, gap: 8 }}>
        <select value={historyTypeFilter} onChange={(e) => setHistoryTypeFilter(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="all">All events</option>
          {historyTypes.map((t) => (
            <option key={t} value={t}>
              {TIMELINE_LABELS[t] ?? t}
            </option>
          ))}
        </select>
        <input
          value={historySearch}
          onChange={(e) => setHistorySearch(e.target.value)}
          placeholder="Search title or detail..."
          style={{ maxWidth: 260 }}
        />
        <span style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
          {visibleHistory.length} of {timeline.length}
        </span>
      </div>
      {timeline.length === 0 && <p className="empty">Nothing has happened yet.</p>}
      {timeline.length > 0 && visibleHistory.length === 0 && <p className="empty">No history entries match this filter.</p>}
      {visibleHistory.length > 0 && (
        <table>
          <thead>
            <tr>
              <th style={{ cursor: "pointer" }} onClick={() => setHistorySortDir((d) => (d === "asc" ? "desc" : "asc"))}>
                When{sortIndicator(true, historySortDir)}
              </th>
              <th>Event</th>
              <th>Title</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {visibleHistory.map((t, idx) => (
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
          <label htmlFor="activity-quality-1">Quality</label>
          <select id="activity-quality-1" value={overrideQuality} onChange={(e) => setOverrideQuality(e.target.value)} style={{ marginBottom: 10 }}>
            <option value="">Auto-detected — {manualImportFor.quality ?? "unknown"}</option>
            {qualities.map((q) => (
              <option key={q.id} value={q.name}>
                {q.name}
              </option>
            ))}
          </select>
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
