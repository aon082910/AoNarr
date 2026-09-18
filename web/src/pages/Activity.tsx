import { useEffect, useMemo, useRef, useState } from "react";
import { api, getApiKey, getSessionToken } from "../api/client.js";
import Modal from "../components/Modal.js";
import { useSortableTable } from "../hooks/useSortableTable.js";
import { RotateCcwIcon, SlashIcon, InboxIcon, ArrowUpCircleIcon, AlertTriangleIcon, ClockIcon, DownloadIcon } from "../components/NavIcons.js";
import { TrashIcon, CheckIcon } from "../components/ActionIcons.js";
import type { QueueItem, Quality, Indexer, DownloadClient } from "../types.js";

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

const PROTOCOL_LABELS: Record<Indexer["protocol"], string> = {
  torznab: "Torrent",
  rss: "Torrent (RSS)",
  newznab: "Usenet",
  ddl: "DDL",
};

type QueueStatusFilter = "all" | "queued" | "downloading" | "failed";
type QueueProtocolFilter = "all" | Indexer["protocol"];
type QueueSortKey = "title" | "season" | "indexer" | "protocol" | "downloadClient" | "status" | "progress" | "quality" | "size";
type HistorySortKey = "when" | "event" | "title" | "detail";

const QUEUE_STATUS_OPTIONS: { value: QueueStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "downloading", label: "Downloading" },
  { value: "queued", label: "Queued" },
  { value: "failed", label: "Failed" },
];

const QUEUE_PROTOCOL_OPTIONS: { value: QueueProtocolFilter; label: string }[] = [
  { value: "all", label: "All protocols" },
  { value: "torznab", label: "Torrent" },
  { value: "newznab", label: "Usenet" },
  { value: "ddl", label: "DDL" },
  { value: "rss", label: "Torrent (RSS)" },
];

const QUEUE_STATUS_RANK: Record<string, number> = { downloading: 0, importing: 1, queued: 2, failed: 3, completed: 4, imported: 5 };

function StatusIcon({ status }: { status: string }) {
  if (status === "downloading") return <DownloadIcon />;
  if (status === "queued") return <ClockIcon />;
  if (status === "importing") return <InboxIcon />;
  if (status === "completed" || status === "imported") return <CheckIcon />;
  if (status === "failed") return <AlertTriangleIcon />;
  return null;
}

export default function Activity() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [indexers, setIndexers] = useState<Indexer[]>([]);
  const [downloadClients, setDownloadClients] = useState<DownloadClient[]>([]);
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
  const [queueProtocolFilter, setQueueProtocolFilter] = useState<QueueProtocolFilter>(
    () => (localStorage.getItem("aonarr_activity_queue_protocol") as QueueProtocolFilter) || "all"
  );
  const { sortRows: sortQueueRows, sortableHeader: queueSortableHeader } = useSortableTable<QueueItem, QueueSortKey>("status", "asc");

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const [historyTypeFilter, setHistoryTypeFilter] = useState<string>(
    () => localStorage.getItem("aonarr_activity_history_type") || "all"
  );
  const [historySearch, setHistorySearch] = useState("");
  const { sortRows: sortHistoryRows, sortableHeader: historySortableHeader } = useSortableTable<TimelineEntry, HistorySortKey>("when", "desc");

  useEffect(() => {
    localStorage.setItem("aonarr_activity_queue_status", queueStatusFilter);
  }, [queueStatusFilter]);

  useEffect(() => {
    localStorage.setItem("aonarr_activity_queue_protocol", queueProtocolFilter);
  }, [queueProtocolFilter]);

  useEffect(() => {
    localStorage.setItem("aonarr_activity_history_type", historyTypeFilter);
  }, [historyTypeFilter]);

  function load() {
    api.get<QueueItem[]>("/activity/queue").then(setQueue);
    api.get<TimelineEntry[]>("/activity/timeline").then(setTimeline);
  }

  useEffect(() => {
    load();
    api.get<Indexer[]>("/indexers").then(setIndexers);
    api.get<DownloadClient[]>("/download-clients").then(setDownloadClients);
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

  const indexerById = useMemo(() => new Map(indexers.map((i) => [i.id, i])), [indexers]);
  const downloadClientById = useMemo(() => new Map(downloadClients.map((c) => [c.id, c])), [downloadClients]);

  function indexerName(id: number | null): string {
    return id != null ? indexerById.get(id)?.name ?? "-" : "-";
  }
  function downloadClientName(id: number | null): string {
    return id != null ? downloadClientById.get(id)?.name ?? "-" : "-";
  }
  function protocolFor(id: number | null): Indexer["protocol"] | null {
    return id != null ? indexerById.get(id)?.protocol ?? null : null;
  }

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

  async function bulkRemove(blocklist = false) {
    const ids = Array.from(selected);
    const results = await Promise.allSettled(ids.map((id) => api.del(`/activity/queue/${id}${blocklist ? "?blocklist=1" : ""}`)));
    const failed = results.filter((r) => r.status === "rejected").length;
    setSelected(new Set());
    load();
    if (failed > 0) alert(`${failed} of ${ids.length} item(s) could not be removed.`);
  }

  async function bulkRetryImport() {
    const ids = Array.from(selected);
    const results = await Promise.allSettled(ids.map((id) => api.post(`/activity/queue/${id}/retry-import`, {})));
    const failed = results.filter((r) => r.status === "rejected").length;
    setSelected(new Set());
    load();
    if (failed > 0) alert(`${failed} of ${ids.length} item(s) failed to retry-import.`);
  }

  function toggleSelected(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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

  const visibleQueue = useMemo(() => {
    let filtered = queueStatusFilter === "all" ? queue : queue.filter((q) => q.status === queueStatusFilter);
    if (queueProtocolFilter !== "all") filtered = filtered.filter((q) => protocolFor(q.indexerId) === queueProtocolFilter);
    return sortQueueRows(filtered, (a, b, key) => {
      if (key === "title") return a.title.localeCompare(b.title);
      if (key === "season") return (a.seasonNumber ?? -1) - (b.seasonNumber ?? -1);
      if (key === "indexer") return indexerName(a.indexerId).localeCompare(indexerName(b.indexerId));
      if (key === "protocol") return (protocolFor(a.indexerId) ?? "").localeCompare(protocolFor(b.indexerId) ?? "");
      if (key === "downloadClient") return downloadClientName(a.downloadClientId).localeCompare(downloadClientName(b.downloadClientId));
      if (key === "status") return (QUEUE_STATUS_RANK[a.status] ?? 9) - (QUEUE_STATUS_RANK[b.status] ?? 9);
      if (key === "progress") return a.progress - b.progress;
      if (key === "quality") return (a.quality ?? "").localeCompare(b.quality ?? "");
      return (a.size ?? 0) - (b.size ?? 0);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, queueStatusFilter, queueProtocolFilter, indexerById, downloadClientById, sortQueueRows]);

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
    return sortHistoryRows(filtered, (a, b, key) => {
      if (key === "event") return (TIMELINE_LABELS[a.type] ?? a.type).localeCompare(TIMELINE_LABELS[b.type] ?? b.type);
      if (key === "title") return a.title.localeCompare(b.title);
      if (key === "detail") return (a.detail ?? "").localeCompare(b.detail ?? "");
      return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;
    });
  }, [timeline, historyTypeFilter, historySearch, sortHistoryRows]);

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
        <select value={queueProtocolFilter} onChange={(e) => setQueueProtocolFilter(e.target.value as QueueProtocolFilter)} style={{ maxWidth: 180 }}>
          {QUEUE_PROTOCOL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button type="button" className="icon-button" onClick={load} title="Refresh" aria-label="Refresh queue">
          <RotateCcwIcon />
        </button>
        <button
          type="button"
          className={selectMode ? "" : "secondary"}
          onClick={() => {
            setSelectMode((v) => !v);
            setSelected(new Set());
          }}
        >
          {selectMode ? "Done selecting" : "Select"}
        </button>
        {selectMode && (
          <>
            <button type="button" className="secondary" onClick={() => setSelected(new Set(visibleQueue.map((q) => q.id)))} title="Selects items matching the current filters only">
              Select all visible
            </button>
            <button type="button" className="secondary" onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
          </>
        )}
        <span style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
          {visibleQueue.length} of {queue.length}
        </span>
      </div>

      {selectMode && selected.size > 0 && (
        <div className="form-panel toolbar" style={{ marginBottom: 10 }}>
          <strong>{selected.size} selected</strong>
          <button type="button" className="icon-button" onClick={bulkRetryImport} title="Retry import for selected items" aria-label="Retry import for selected items">
            <RotateCcwIcon />
          </button>
          <button type="button" className="icon-button danger" onClick={() => bulkRemove(false)} title="Remove selected items" aria-label="Remove selected items">
            <TrashIcon />
          </button>
          <button type="button" className="icon-button danger" onClick={() => bulkRemove(true)} title="Remove selected items and blocklist their releases" aria-label="Remove and blocklist selected items">
            <SlashIcon />
          </button>
        </div>
      )}

      {queue.length === 0 && <p className="empty">Nothing in the queue.</p>}
      {queue.length > 0 && visibleQueue.length === 0 && <p className="empty">No queue items match this filter.</p>}
      {visibleQueue.length > 0 && (
        <table>
          <thead>
            <tr>
              {selectMode && <th></th>}
              {queueSortableHeader("title", "Title")}
              {queueSortableHeader("season", "Season")}
              {queueSortableHeader("indexer", "Indexer")}
              {queueSortableHeader("protocol", "Protocol")}
              {queueSortableHeader("downloadClient", "Download Client")}
              {queueSortableHeader("status", "Status")}
              {queueSortableHeader("progress", "Progress")}
              {queueSortableHeader("quality", "Quality")}
              {queueSortableHeader("size", "Size")}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visibleQueue.map((q) => {
              const protocol = protocolFor(q.indexerId);
              return (
                <tr key={q.id}>
                  {selectMode && (
                    <td>
                      <input type="checkbox" checked={selected.has(q.id)} onChange={() => toggleSelected(q.id)} aria-label={`Select ${q.title}`} />
                    </td>
                  )}
                  <td>
                    {q.title}
                    {q.retryCount > 0 && (
                      <span className="badge" style={{ marginLeft: 6 }} title="Auto-retried after an earlier release failed">
                        retry {q.retryCount}
                      </span>
                    )}
                  </td>
                  <td>{q.seasonNumber != null ? `S${q.seasonNumber}` : "-"}</td>
                  <td>{indexerName(q.indexerId)}</td>
                  <td>{protocol ? PROTOCOL_LABELS[protocol] : "-"}</td>
                  <td>{downloadClientName(q.downloadClientId)}</td>
                  <td>
                    <span
                      className={`badge ${
                        q.status === "completed" || q.status === "imported"
                          ? "ok"
                          : q.status === "failed"
                          ? "danger"
                          : ""
                      }`}
                      style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                    >
                      <StatusIcon status={q.status} />
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
                      <button type="button" className="icon-button" onClick={() => setPriority(q.id, "top")} title="Prioritize" aria-label="Prioritize">
                        <ArrowUpCircleIcon />
                      </button>
                    )}
                    {(q.status === "failed" || q.status === "completed") && (
                      <>
                        <button
                          type="button"
                          className="icon-button"
                          disabled={retrying === q.id}
                          onClick={() => retryImport(q.id)}
                          title={retrying === q.id ? "Retrying..." : "Retry import"}
                          aria-label="Retry import"
                        >
                          <RotateCcwIcon />
                        </button>
                        <button type="button" className="icon-button" onClick={() => openManualImport(q)} title="Manual import..." aria-label="Manual import">
                          <InboxIcon />
                        </button>
                      </>
                    )}
                    <button type="button" className="icon-button danger" onClick={() => remove(q.id)} title="Remove" aria-label="Remove">
                      <TrashIcon />
                    </button>
                    <button type="button" className="icon-button danger" onClick={() => remove(q.id, true)} title="Remove &amp; Blocklist" aria-label="Remove and blocklist">
                      <SlashIcon />
                    </button>
                  </td>
                </tr>
              );
            })}
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
              {historySortableHeader("when", "When")}
              {historySortableHeader("event", "Event")}
              {historySortableHeader("title", "Title")}
              {historySortableHeader("detail", "Detail")}
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
                      <button type="button" className="icon-button" disabled={importing === c.path} onClick={() => manualImport(c.path)} title={importing === c.path ? "Importing..." : "Import"} aria-label="Import this file">
                        <InboxIcon />
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
