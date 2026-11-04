import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api, openEventStream } from "../api/client.js";
import Modal from "../components/Modal.js";
import { useSortableTable } from "../hooks/useSortableTable.js";
import { RotateCcwIcon, SlashIcon, InboxIcon, ArrowUpCircleIcon, AlertTriangleIcon, ClockIcon, DownloadIcon } from "../components/NavIcons.js";
import { TrashIcon, CheckIcon } from "../components/ActionIcons.js";
import { ToolbarButton } from "../components/PageToolbar.js";
import Pagination, { DEFAULT_PAGE_SIZE_OPTIONS } from "../components/Pagination.js";
import type { QueueItem, Quality, Indexer, DownloadClient } from "../types.js";
import { notify } from "../utils/notify.js";
import { confirmDialog } from "../utils/confirmDialog.js";
import { formatServerTimestamp } from "../utils/format.js";

interface ImportCandidate {
  path: string;
  size: number;
  mtimeMs: number;
}

/** What a manual import would do (POST /activity/queue/:id/manual-import with preview). */
interface ManualImportPreview {
  sourceFile: string;
  mode: string;
  destPath: string | null;
  sourceKept: boolean;
  warnings: string[];
  error?: string;
  note?: string;
}

const IMPORT_MODE_LABELS: Record<string, string> = { move: "Move", copy: "Copy", hardlink: "Hardlink", symlink: "Symlink" };

interface TimelineEntry {
  timestamp: string;
  type: string;
  title: string;
  detail: string | null;
  /** How a grab came about: "interactive" (picked by hand), "auto", "rss", ... Null for other events. */
  source?: string | null;
  /** The admin grabbed a release the list had rejected. */
  forced?: boolean;
}

/** A release a delay profile is holding back (GET /activity/pending). */
interface PendingRelease {
  id: number;
  mediaItemId: number;
  mediaTitle: string;
  mediaType: string;
  target: string | null;
  reason: "delay";
  delayMinutes: number;
  readyInMinutes: number | null;
  expiresAt: string | null;
  release: { title: string; size: number | null; protocol: string; indexerName: string; publishDate: string | null; seeders: number | null; quality: string };
}

/** A release the RSS sync judged, with what it decided (GET /activity/rss-decisions). */
interface RssDecision {
  id: number;
  createdAt: string;
  indexerName: string | null;
  title: string;
  protocol: string | null;
  outcome: "grabbed" | "held" | "rejected" | "unmatched" | "skipped";
  reason: string | null;
  mediaItemId: number | null;
  mediaTitle: string | null;
}

/** What a library search offers to map a release to. */
interface MapCandidate {
  id: number;
  title: string;
  type: string;
  year: number | null;
}

const SOURCE_LABELS: Record<string, string> = { interactive: "Manual", auto: "Automatic search", rss: "RSS sync", irc: "IRC announce" };

/** 5400 -> "1h 30m", 45 -> "45s"; null when the client gave no estimate. */
function formatEta(seconds: number | null | undefined): string | null {
  if (seconds == null) return null;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  if (hours < 48) return `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatReady(minutes: number | null): string {
  if (minutes == null) return "when the delay ends";
  if (minutes <= 0) return "any moment";
  if (minutes < 60) return `in ${minutes} min`;
  return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
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
  rss: "RSS",
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
  { value: "rss", label: "RSS" },
];

const QUEUE_STATUS_RANK: Record<string, number> = { downloading: 0, importing: 1, queued: 2, failed: 3, completed: 4, imported: 5 };

/** The Queue table's own status badge printed q.status raw ("downloading", "completed", ...)
 * instead of a proper label, unlike TIMELINE_LABELS/PROTOCOL_LABELS above for the same kind of
 * fact elsewhere on this page. */
const QUEUE_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  downloading: "Downloading",
  importing: "Importing",
  completed: "Completed",
  imported: "Imported",
  failed: "Failed",
};

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
  const [pending, setPending] = useState<PendingRelease[]>([]);
  const [pendingBusy, setPendingBusy] = useState<number | null>(null);
  const [rssOpen, setRssOpen] = useState(false);
  const [rssDecisions, setRssDecisions] = useState<RssDecision[]>([]);
  const [rssTotal, setRssTotal] = useState(0);
  const [rssBusy, setRssBusy] = useState<number | null>(null);
  const [mapFor, setMapFor] = useState<number | null>(null);
  const [mapQuery, setMapQuery] = useState("");
  const [mapResults, setMapResults] = useState<MapCandidate[]>([]);
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
  // "" follows the import strategy setting; the others are for this import alone.
  const [importMode, setImportMode] = useState("");
  const [previews, setPreviews] = useState<Record<string, ManualImportPreview | { error: string }>>({});
  const [previewing, setPreviewing] = useState<string | null>(null);

  const [queueStatusFilter, setQueueStatusFilter] = useState<QueueStatusFilter>(
    () => (localStorage.getItem("aonarr_activity_queue_status") as QueueStatusFilter) || "all"
  );
  const [queueProtocolFilter, setQueueProtocolFilter] = useState<QueueProtocolFilter>(
    () => (localStorage.getItem("aonarr_activity_queue_protocol") as QueueProtocolFilter) || "all"
  );
  const { sortRows: sortQueueRows, sortableHeader: queueSortableHeader } = useSortableTable<QueueItem, QueueSortKey>("status", "asc");

  // Queue and History are independent, server-paginated lists on this one page — each gets its own
  // page/pageSize/total, matching how AuditLog.tsx/LibraryType.tsx paginate a single list.
  const [queuePage, setQueuePage] = useState(1);
  const [queuePageSize, setQueuePageSize] = useState<number>(
    () => Number(localStorage.getItem("aonarr_activity_queue_page_size")) || 60
  );
  const [queueTotal, setQueueTotal] = useState(0);

  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState<number>(
    () => Number(localStorage.getItem("aonarr_activity_history_page_size")) || 60
  );
  const [historyTotal, setHistoryTotal] = useState(0);

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

  useEffect(() => {
    localStorage.setItem("aonarr_activity_queue_page_size", String(queuePageSize));
  }, [queuePageSize]);

  useEffect(() => {
    localStorage.setItem("aonarr_activity_history_page_size", String(historyPageSize));
  }, [historyPageSize]);

  // Both status/protocol (Queue) and type/search (History) filter client-side over whatever page is
  // currently loaded (unchanged — see below), so sitting on page 4 when a filter changes would show
  // a confusing, possibly-empty page of the new filter's results. Reset to page 1 instead.
  useEffect(() => {
    setQueuePage(1);
  }, [queueStatusFilter, queueProtocolFilter]);

  useEffect(() => {
    setHistoryPage(1);
  }, [historyTypeFilter, historySearch]);

  function loadQueue() {
    const params = new URLSearchParams();
    params.set("limit", String(queuePageSize));
    params.set("offset", String((queuePage - 1) * queuePageSize));
    api.get<{ items: QueueItem[]; total: number }>(`/activity/queue?${params.toString()}`).then((data) => {
      setQueue(data.items);
      setQueueTotal(data.total);
      // Imported/removed downloads leave the queue, so the page being viewed can empty out from
      // under a refresh — step back to the last page that still has rows instead of stranding the
      // view on an empty page.
      if (data.items.length === 0 && queuePage > 1) setQueuePage(Math.max(1, Math.ceil(data.total / queuePageSize)));
    });
  }

  function loadPending() {
    api.get<{ items: PendingRelease[] }>("/activity/pending").then((data) => setPending(data.items)).catch(() => {});
  }

  async function grabPendingNow(p: PendingRelease) {
    setPendingBusy(p.id);
    try {
      await api.post(`/activity/pending/${p.id}/grab`);
      notify.success(`Sent "${p.release.title}" to the download client now.`);
      loadRef.current();
    } catch (e) {
      notify.error(`Grab failed: ${(e as Error).message}`);
    } finally {
      setPendingBusy(null);
    }
  }

  async function forgetPending(p: PendingRelease) {
    setPendingBusy(p.id);
    try {
      await api.del(`/activity/pending/${p.id}`);
      loadPending();
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setPendingBusy(null);
    }
  }

  function loadRssDecisions() {
    api
      .get<{ items: RssDecision[]; total: number }>("/activity/rss-decisions?limit=50")
      .then((data) => {
        setRssDecisions(data.items);
        setRssTotal(data.total);
      })
      .catch(() => {});
  }

  /** Teaches the title the release's name and judges that release again (POST /activity/rss-decisions/:id/map). */
  async function mapRelease(row: RssDecision, item: MapCandidate) {
    setRssBusy(row.id);
    try {
      const done = await api.post<RssDecision>(`/activity/rss-decisions/${row.id}/map`, { mediaItemId: item.id });
      if (done.outcome === "grabbed") notify.success(`Mapped to "${item.title}" and sent to the download client.`);
      else notify.info(`Mapped to "${item.title}": ${done.reason ?? done.outcome}`);
      setMapFor(null);
      setMapQuery("");
      loadRssDecisions();
      loadRef.current();
    } catch (e) {
      notify.error(`Mapping failed: ${(e as Error).message}`);
    } finally {
      setRssBusy(null);
    }
  }

  function loadHistory() {
    const params = new URLSearchParams();
    params.set("limit", String(historyPageSize));
    params.set("offset", String((historyPage - 1) * historyPageSize));
    api.get<{ items: TimelineEntry[]; total: number }>(`/activity/timeline?${params.toString()}`).then((data) => {
      setTimeline(data.items);
      setHistoryTotal(data.total);
    });
  }

  function load() {
    loadQueue();
    loadPending();
    if (rssOpen) loadRssDecisions();
    loadHistory();
  }

  // The 30s poll and the SSE "queue" listener below are set up once, on mount — without this ref
  // they'd keep calling the `load` closure captured at that moment (queuePage/historyPage === 1
  // forever), silently snapping the view back to page 1's data every time they fired instead of
  // refreshing whichever page is actually on screen.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(loadQueue, [queuePage, queuePageSize]);
  useEffect(loadPending, []);
  useEffect(() => {
    if (rssOpen) loadRssDecisions();
  }, [rssOpen]);
  // The picker of the "map to" step: a library search as the admin types.
  useEffect(() => {
    if (mapFor == null || mapQuery.trim().length < 2) {
      setMapResults([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .get<{ items: MapCandidate[] }>(`/media?q=${encodeURIComponent(mapQuery.trim())}&limit=8`)
        .then((data) => setMapResults(data.items))
        .catch(() => setMapResults([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [mapFor, mapQuery]);
  useEffect(loadHistory, [historyPage, historyPageSize]);

  useEffect(() => {
    api.get<Indexer[]>("/indexers").then(setIndexers);
    api.get<DownloadClient[]>("/download-clients").then(setDownloadClients);
    // 30s fallback poll — a safety net in case the SSE connection below never opens (e.g. a proxy
    // in front of AoNarr that buffers/blocks text/event-stream) or drops without EventSource's own
    // auto-reconnect kicking in for some reason. Real-time updates come from the "queue" event.
    const interval = setInterval(() => loadRef.current(), 30000);

    const closeStream = openEventStream("/activity/stream", (stream) => {
      stream.addEventListener("queue", () => loadRef.current());
    });

    return () => {
      clearInterval(interval);
      closeStream();
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

  /** Asks whether to also remove the download from its client (which deletes its downloaded data)
   * and returns the DELETE query string, or null if cancelled. */
  async function confirmQueueRemoval(subject: string, count: number, blocklist: boolean): Promise<string | null> {
    const confirmed = await confirmDialog({
      title: blocklist ? "Remove & blocklist" : "Remove from queue",
      message: blocklist
        ? `Remove ${subject} from the queue and blocklist ${count === 1 ? "its release" : "their releases"}?`
        : `Remove ${subject} from the queue?`,
      confirmLabel: blocklist ? "Remove & blocklist" : "Remove",
      danger: true,
      options: [
        { key: "removeFromClient", label: "Remove from download client (deletes its downloaded data)", defaultChecked: true },
        ...(blocklist ? [{ key: "searchReplacement", label: "Search for a replacement release now", defaultChecked: true }] : []),
      ],
    });
    if (!confirmed) return null;
    const params = [
      blocklist && "blocklist=1",
      !confirmed.values.removeFromClient && "removeFromClient=0",
      blocklist && !confirmed.values.searchReplacement && "skipRedownload=1",
    ]
      .filter(Boolean)
      .join("&");
    return params ? `?${params}` : "";
  }

  async function remove(item: QueueItem, blocklist = false) {
    const query = await confirmQueueRemoval(`"${item.title}"`, 1, blocklist);
    if (query === null) return;
    try {
      await api.del(`/activity/queue/${item.id}${query}`);
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      load();
    }
  }

  async function setPriority(id: number, priority: "top" | "normal") {
    try {
      await api.post(`/activity/queue/${id}/priority`, { priority });
      load();
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  async function retryImport(id: number) {
    setRetrying(id);
    try {
      await api.post(`/activity/queue/${id}/retry-import`, {});
      load();
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setRetrying(null);
    }
  }

  async function bulkRemove(blocklist = false) {
    const ids = Array.from(selected);
    const query = await confirmQueueRemoval(`${ids.length} item(s)`, ids.length, blocklist);
    if (query === null) return;
    const results = await Promise.allSettled(ids.map((id) => api.del(`/activity/queue/${id}${query}`)));
    const failed = results.filter((r) => r.status === "rejected").length;
    setSelected(new Set());
    load();
    if (failed > 0) notify.error(`${failed} of ${ids.length} item(s) could not be removed.`);
  }

  async function bulkRetryImport() {
    const ids = Array.from(selected);
    const results = await Promise.allSettled(ids.map((id) => api.post(`/activity/queue/${id}/retry-import`, {})));
    const failed = results.filter((r) => r.status === "rejected").length;
    setSelected(new Set());
    load();
    if (failed > 0) notify.error(`${failed} of ${ids.length} item(s) failed to retry-import.`);
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
    setImportMode("");
    setPreviews({});
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
      await api.post(`/activity/queue/${manualImportFor.id}/manual-import`, { sourceFile, quality: overrideQuality || undefined, mode: importMode || undefined });
      setManualImportFor(null);
      load();
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setImporting(null);
    }
  }

  /** Asks what importing the file would do, without importing it. Cleared again when the mode or quality changes. */
  async function previewManualImport(sourceFile: string) {
    if (!manualImportFor) return;
    setPreviewing(sourceFile);
    try {
      const result = await api.post<ManualImportPreview>(`/activity/queue/${manualImportFor.id}/manual-import`, {
        sourceFile,
        quality: overrideQuality || undefined,
        mode: importMode || undefined,
        preview: true,
      });
      setPreviews((prev) => ({ ...prev, [sourceFile]: result }));
    } catch (e) {
      setPreviews((prev) => ({ ...prev, [sourceFile]: { error: (e as Error).message } }));
    } finally {
      setPreviewing(null);
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

  const queueTotalPages = Math.max(1, Math.ceil(queueTotal / queuePageSize));
  const historyTotalPages = Math.max(1, Math.ceil(historyTotal / historyPageSize));

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
        <ToolbarButton icon={<RotateCcwIcon />} label="Refresh" onClick={load} title="Refresh queue" />
        <ToolbarButton
          icon={<CheckIcon />}
          label={selectMode ? "Done selecting" : "Select"}
          onClick={() => {
            setSelectMode((v) => !v);
            setSelected(new Set());
          }}
        />
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
          {visibleQueue.length} of {queue.length} on this page ({queueTotal} total)
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

      {pending.length > 0 && (
        <>
          <h3 style={{ marginBottom: 4 }}>Waiting for a delay ({pending.length})</h3>
          <p style={{ color: "var(--muted)", marginTop: 0, fontSize: "0.85rem" }}>
            Releases a delay profile is holding back. Each is grabbed by itself when its delay ends, and forgotten after a week.
          </p>
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Release</th>
                <th>Quality</th>
                <th>Ready</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pending.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.mediaTitle}
                    {p.target && <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>{p.target}</div>}
                  </td>
                  <td>
                    {p.release.title}
                    <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                      {p.release.indexerName} · {p.release.protocol}
                      {p.release.size ? ` · ${formatSize(p.release.size)}` : ""}
                    </div>
                  </td>
                  <td>{p.release.quality}</td>
                  <td title={`Delay of ${p.delayMinutes} minutes for ${p.release.protocol} releases`}>{formatReady(p.readyInMinutes)}</td>
                  <td className="toolbar">
                    <button type="button" className="icon-button" disabled={pendingBusy === p.id} onClick={() => grabPendingNow(p)} title="Grab now, without waiting" aria-label="Grab now">
                      <DownloadIcon />
                    </button>
                    <button type="button" className="icon-button danger" disabled={pendingBusy === p.id} onClick={() => forgetPending(p)} title="Forget this release" aria-label="Forget this release">
                      <TrashIcon />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <details onToggle={(e) => setRssOpen((e.currentTarget as HTMLDetailsElement).open)} style={{ margin: "12px 0" }}>
        <summary style={{ cursor: "pointer" }}>Recent RSS releases{rssOpen ? ` (${rssTotal})` : ""}</summary>
        <p style={{ color: "var(--muted)", marginTop: 4, fontSize: "0.85rem" }}>
          The newest releases the RSS sync judged and what it decided. A release that names nothing the library wants can be mapped to a title: the title learns
          the release's name, and that release is judged again at once.
        </p>
        {rssDecisions.length === 0 && <p className="empty">No releases judged yet.</p>}
        {rssDecisions.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Release</th>
                <th>Item</th>
                <th>Decision</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rssDecisions.map((d) => (
                <Fragment key={d.id}>
                  <tr>
                    <td>
                      {d.title}
                      <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                        {d.indexerName ?? "indexer removed"}
                        {d.protocol ? ` · ${d.protocol}` : ""} · {formatServerTimestamp(d.createdAt)}
                      </div>
                    </td>
                    <td>{d.mediaTitle ?? "-"}</td>
                    <td>
                      {d.outcome}
                      {d.reason && d.outcome !== "grabbed" && <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>{d.reason}</div>}
                    </td>
                    <td className="toolbar">
                      {(d.outcome === "unmatched" || d.outcome === "rejected" || d.outcome === "skipped") && (
                        <button
                          type="button"
                          disabled={rssBusy === d.id}
                          onClick={() => {
                            setMapFor(mapFor === d.id ? null : d.id);
                            setMapQuery("");
                          }}
                        >
                          Map to...
                        </button>
                      )}
                    </td>
                  </tr>
                  {mapFor === d.id && (
                    <tr>
                      <td colSpan={4}>
                        <input type="search" autoFocus placeholder="Search the library for the title this release is" value={mapQuery} onChange={(e) => setMapQuery(e.target.value)} aria-label="Search the library" />
                        {mapResults.map((m) => (
                          <button key={m.id} type="button" style={{ display: "block", margin: "4px 0" }} disabled={rssBusy === d.id} onClick={() => mapRelease(d, m)}>
                            {m.title}
                            {m.year ? ` (${m.year})` : ""} · {m.type}
                          </button>
                        ))}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </details>

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
                    {q.albums && q.albums.length > 0 && (
                      <span className="badge" style={{ marginLeft: 6 }} title={q.albums.map((a) => a.title).join(", ")}>
                        {q.albums.length} album{q.albums.length === 1 ? "" : "s"}
                      </span>
                    )}
                    {q.retryCount > 0 && (
                      <span className="badge" style={{ marginLeft: 6 }} title="Auto-retried after an earlier release failed">
                        retry {q.retryCount}
                      </span>
                    )}
                    {(q.clientNote ?? q.statusMessage) && (
                      <div style={{ fontSize: "0.75rem", color: q.clientState === "warning" || q.status === "failed" ? "var(--danger)" : "var(--muted)" }}>
                        {q.clientNote ?? q.statusMessage}
                      </div>
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
                      title={q.status === "completed" && q.importSkippedReason ? `Not imported: ${q.importSkippedReason}` : undefined}
                    >
                      <StatusIcon status={q.status} />
                      {QUEUE_STATUS_LABELS[q.status] ?? q.status}
                    </span>
                  </td>
                  <td>
                    <div className="progress-bar">
                      <div style={{ width: `${Math.round(q.progress * 100)}%` }} />
                    </div>
                    {q.status === "downloading" && (q.etaSeconds != null || q.sizeLeft != null) && (
                      <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                        {[q.etaSeconds != null && q.clientState !== "paused" ? `ETA ${formatEta(q.etaSeconds)}` : null, q.sizeLeft != null ? `${formatSize(q.sizeLeft)} left` : null].filter(Boolean).join(" · ")}
                      </div>
                    )}
                  </td>
                  <td>{q.quality ?? "-"}</td>
                  <td>{q.size ? formatSize(q.size) : "-"}</td>
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
                    <button type="button" className="icon-button danger" onClick={() => remove(q)} title="Remove" aria-label="Remove">
                      <TrashIcon />
                    </button>
                    <button type="button" className="icon-button danger" onClick={() => remove(q, true)} title="Remove &amp; Blocklist" aria-label="Remove and blocklist">
                      <SlashIcon />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {queueTotal > 0 && (
        <Pagination
          page={queuePage}
          totalPages={queueTotalPages}
          total={queueTotal}
          pageSize={queuePageSize}
          hasPrev={queuePage > 1}
          hasNext={queuePage < queueTotalPages}
          onPrev={() => setQueuePage((p) => p - 1)}
          onNext={() => setQueuePage((p) => p + 1)}
          onPageSizeChange={(n) => {
            setQueuePageSize(n);
            setQueuePage(1);
          }}
          pageSizeOptions={DEFAULT_PAGE_SIZE_OPTIONS}
        />
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
          {visibleHistory.length} of {timeline.length} on this page ({historyTotal} total)
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
                <td>{formatServerTimestamp(t.timestamp)}</td>
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
                <td>
                  {t.detail ?? "-"}
                  {t.source && (
                    <span className="badge" style={{ marginLeft: 6 }} title="How this release came to be grabbed">
                      {SOURCE_LABELS[t.source] ?? t.source}
                      {t.forced ? ", over a rejection" : ""}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {timeline.length > 0 && (
        <Pagination
          page={historyPage}
          totalPages={historyTotalPages}
          total={historyTotal}
          pageSize={historyPageSize}
          hasPrev={historyPage > 1}
          hasNext={historyPage < historyTotalPages}
          onPrev={() => setHistoryPage((p) => p - 1)}
          onNext={() => setHistoryPage((p) => p + 1)}
          onPageSizeChange={(n) => {
            setHistoryPageSize(n);
            setHistoryPage(1);
          }}
          pageSizeOptions={DEFAULT_PAGE_SIZE_OPTIONS}
        />
      )}

      {manualImportFor && (
        <Modal title={`Manual import — ${manualImportFor.title}`} onClose={() => setManualImportFor(null)} maxWidth={640}>
          <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
            Files found in the downloads directory matching this library's file types, newest
            first. Pick the one that's actually this download if AoNarr couldn't find or match it
            automatically.
          </p>
          <label htmlFor="activity-quality-1">Quality</label>
          <select id="activity-quality-1" value={overrideQuality} onChange={(e) => {
              setOverrideQuality(e.target.value);
              setPreviews({});
            }} style={{ marginBottom: 10 }}>
            <option value="">Auto-detected — {manualImportFor.quality ?? "unknown"}</option>
            {qualities.map((q) => (
              <option key={q.id} value={q.name}>
                {q.name}
              </option>
            ))}
          </select>
          <label htmlFor="activity-import-mode">Import mode</label>
          <select
            id="activity-import-mode"
            value={importMode}
            onChange={(e) => {
              setImportMode(e.target.value);
              setPreviews({});
            }}
            style={{ marginBottom: 10 }}
          >
            <option value="">Default (the import strategy setting)</option>
            {Object.entries(IMPORT_MODE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
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
                  <Fragment key={c.path}>
                  <tr>
                    <td style={{ fontFamily: "monospace", fontSize: "0.8rem", wordBreak: "break-all" }}>{c.path}</td>
                    <td>{formatSize(c.size)}</td>
                    <td className="toolbar">
                      <button type="button" className="secondary" disabled={previewing === c.path} onClick={() => previewManualImport(c.path)} title="Shows where the file would go and what to look out for, without importing it">
                        {previewing === c.path ? "Checking..." : "Preview"}
                      </button>
                      <button type="button" className="icon-button" disabled={importing === c.path} onClick={() => manualImport(c.path)} title={importing === c.path ? "Importing..." : "Import"} aria-label="Import this file">
                        <InboxIcon />
                      </button>
                    </td>
                  </tr>
                  {previews[c.path] && (
                    <tr>
                      <td colSpan={3} style={{ fontSize: "0.8rem" }}>
                        {"error" in previews[c.path] && !("mode" in previews[c.path]) ? (
                          <span style={{ color: "var(--danger)" }}>{(previews[c.path] as { error: string }).error}</span>
                        ) : (
                          (() => {
                            const p = previews[c.path] as ManualImportPreview;
                            return (
                              <div>
                                <div>
                                  {IMPORT_MODE_LABELS[p.mode] ?? p.mode}: {p.sourceKept ? "the download stays where it is" : "the download is moved out of its folder"}
                                </div>
                                {p.destPath && <div style={{ fontFamily: "monospace", wordBreak: "break-all" }}>to {p.destPath}</div>}
                                {p.note && <div style={{ color: "var(--muted)" }}>{p.note}</div>}
                                {p.error && <div style={{ color: "var(--danger)" }}>It would be refused: {p.error}</div>}
                                {p.warnings.map((w) => (
                                  <div key={w} style={{ color: "var(--danger)" }}>
                                    {w}
                                  </div>
                                ))}
                              </div>
                            );
                          })()
                        )}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      )}
    </div>
  );
}
