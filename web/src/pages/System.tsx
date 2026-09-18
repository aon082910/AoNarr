import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, downloadFile, uploadRaw } from "../api/client.js";
import FolderPicker from "../components/FolderPicker.js";
import SettingsSectionTiles from "../components/SettingsSectionTiles.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import { useSortableTable } from "../hooks/useSortableTable.js";
import { formatBytes } from "../utils/format.js";
import { RotateCcwIcon, DownloadIcon, InboxIcon } from "../components/NavIcons.js";
import { TrashIcon, FolderIcon, ArrowRightIcon } from "../components/ActionIcons.js";
import { notify } from "../utils/notify.js";
import { confirmDialog } from "../utils/confirmDialog.js";

interface DiskSpaceEntry {
  path: string;
  mediaType: string;
  freeBytes: number | null;
  totalBytes: number | null;
  daysUntilFull: number | null;
}

interface SystemStatus {
  version: string;
  nodeVersion: string;
  platform: string;
  uptimeSeconds: number;
  libraryCounts: Record<string, number>;
  queueCount: number;
  indexerCount: number;
  downloadClientCount: number;
  diskSpace: DiskSpaceEntry[];
}

interface LogFile {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

interface UpdateCheckResult {
  currentRound: number | null;
  currentTitle: string | null;
  latestRound: number | null;
  latestTitle: string | null;
  updateAvailable: boolean;
}

interface ArchivalCandidate {
  mediaItemId: number;
  title: string;
  type: string;
  filePath: string;
  scheduledFor: string;
}

interface SystemResources {
  cpuCount: number;
  loadAvg: [number, number, number];
  memory: { totalBytes: number; freeBytes: number; usedBytes: number; usedPercent: number };
  process: { rssBytes: number; uptimeSeconds: number };
}

interface IndexerRecentHealth {
  totalChecks: number;
  successCount: number;
  successRate: number | null;
  avgResponseTimeMs: number | null;
  lastCheckedAt: string | null;
  lastSuccess: boolean | null;
  lastError: string | null;
}

interface IndexerHealth {
  id: number;
  name: string;
  ok: boolean;
  error?: string;
  /** Historical success rate over the last ~50 real search attempts — distinct from `ok` above,
   * which is only a live "is it reachable right now" check. See services/indexerHealth.ts. */
  recent?: IndexerRecentHealth;
}

interface ConfigWarning {
  key: string;
  message: string;
}

interface StuckQueueEntry {
  id: number;
  title: string;
  status: string;
  addedAt: string;
  mediaTitle: string;
}

interface RepeatedImport {
  mediaItemId: number;
  mediaTitle: string;
  target: string;
  importCount: number;
  qualities: (string | null)[];
}

interface UpgradeCandidate {
  mediaItemId: number;
  target: string;
  currentQuality: string;
  cutoff: string;
  profileName: string;
}

interface DownloadClientHealth {
  id: number;
  name: string;
  ok: boolean;
  error?: string;
}

interface DiskWarning {
  rootFolderId: number;
  path: string;
  percentFree: number;
}

interface HealthReport {
  configWarnings: ConfigWarning[];
  indexers: IndexerHealth[];
  downloadClients: DownloadClientHealth[];
  stuckQueue: StuckQueueEntry[];
  stuckQueueThresholdHours: number;
  pendingRequests: number;
  repeatedImports: RepeatedImport[];
  upgradeCandidates: UpgradeCandidate[];
  diskWarnings: DiskWarning[];
  diskWarnPercentFree: number;
}

interface OrphanedFile {
  path: string;
  sizeBytes: number;
}

interface UnmonitoredNoFileItem {
  id: number;
  type: string;
  title: string;
  year: number | null;
  addedAt: string;
}

interface DuplicateFileGroup {
  sizeBytes: number;
  files: { path: string; label: string; mediaItemId: number }[];
}

interface ReleaseGroupStatsRow {
  releaseGroup: string;
  successes: number;
  failures: number;
  successRate: number;
}

interface LibraryMismatch {
  mediaItemId: number;
  type: string;
  label: string;
  path: string;
}

interface LogEntry {
  level: "info" | "warn" | "error";
  message: string;
  timestamp: string;
}

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 60)}m`;
}

export default function System() {
  const navigate = useNavigate();
  const mediaTypes = useMediaTypes();
  const [tab, setTab] = useState("overview");
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [resources, setResources] = useState<SystemResources | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const { sortRows: sortIndexerHealth, sortableHeader: indexerHealthHeader } = useSortableTable<IndexerHealth, "indexer" | "status" | "rate">("indexer");
  const { sortRows: sortClientHealth, sortableHeader: clientHealthHeader } = useSortableTable<DownloadClientHealth, "client" | "status">("client");
  const { sortRows: sortStuckQueue, sortableHeader: stuckQueueHeader } = useSortableTable<StuckQueueEntry, "media" | "release" | "status" | "added">(
    "added"
  );
  const { sortRows: sortRepeatedImports, sortableHeader: repeatedImportsHeader } = useSortableTable<RepeatedImport, "item" | "count">("count", "desc");
  const { sortRows: sortUpgradeCandidates, sortableHeader: upgradeCandidatesHeader } = useSortableTable<UpgradeCandidate, "item" | "current" | "cutoff">(
    "item"
  );
  const [orphaned, setOrphaned] = useState<OrphanedFile[] | null>(null);
  const { sortRows: sortOrphaned, sortableHeader: orphanedHeader } = useSortableTable<OrphanedFile, "path" | "size">("path");
  const [orphanedIncremental, setOrphanedIncremental] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [scanningLibrary, setScanningLibrary] = useState(false);
  const [upcomingArchivals, setUpcomingArchivals] = useState<ArchivalCandidate[] | null>(null);
  const { sortRows: sortArchivals, sortableHeader: archivalsHeader } = useSortableTable<ArchivalCandidate, "title" | "type" | "scheduled">(
    "scheduled"
  );
  const [loadingUpcoming, setLoadingUpcoming] = useState(false);
  const [syncingTrakt, setSyncingTrakt] = useState(false);
  const [syncingPlexWatchlist, setSyncingPlexWatchlist] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameType, setRenameType] = useState("");
  const [renameResult, setRenameResult] = useState<{
    renamed: { title: string; from: string; to: string }[];
    errors: { title: string; error: string }[];
    skippedMusic: number;
  } | null>(null);
  const { sortRows: sortRenamed, sortableHeader: renamedHeader } = useSortableTable<{ title: string; from: string; to: string }, "title" | "to">(
    "title"
  );
  const { sortRows: sortRenameErrors, sortableHeader: renameErrorsHeader } = useSortableTable<{ title: string; error: string }, "title" | "error">(
    "title"
  );
  const [backingUp, setBackingUp] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const [logs, setLogs] = useState<LogEntry[] | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logLevelFilter, setLogLevelFilter] = useState("");
  const [logSearch, setLogSearch] = useState("");
  const [logFiles, setLogFiles] = useState<LogFile[] | null>(null);
  const { sortRows: sortLogFiles, sortableHeader: logFilesHeader } = useSortableTable<LogFile, "file" | "size" | "modified">("modified", "desc");
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateCheckError, setUpdateCheckError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [showBackupDirPicker, setShowBackupDirPicker] = useState(false);
  const [unmonitoredNoFile, setUnmonitoredNoFile] = useState<UnmonitoredNoFileItem[] | null>(null);
  const [deletingAllUnmonitored, setDeletingAllUnmonitored] = useState(false);
  const { sortRows: sortUnmonitoredNoFile, sortableHeader: unmonitoredNoFileHeader } = useSortableTable<
    UnmonitoredNoFileItem,
    "title" | "type" | "added"
  >("title");
  const { sortRows: sortDiskSpace, sortableHeader: diskSpaceHeader } = useSortableTable<DiskSpaceEntry, "path" | "type" | "free" | "total" | "days">(
    "path"
  );
  const [duplicateFiles, setDuplicateFiles] = useState<DuplicateFileGroup[] | null>(null);
  const [cleanupLoading, setCleanupLoading] = useState<"unmonitored" | "duplicates" | null>(null);
  const [groupStats, setGroupStats] = useState<ReleaseGroupStatsRow[] | null>(null);
  const { sortRows: sortGroupStats, sortableHeader: groupStatsHeader } = useSortableTable<
    ReleaseGroupStatsRow,
    "group" | "successes" | "failures" | "rate"
  >("rate", "desc");
  const [groupStatsLoading, setGroupStatsLoading] = useState(false);
  const [libraryMismatches, setLibraryMismatches] = useState<LibraryMismatch[] | null>(null);
  const { sortRows: sortMismatches, sortableHeader: mismatchesHeader } = useSortableTable<LibraryMismatch, "item" | "path">("item");
  const [libraryValidationLoading, setLibraryValidationLoading] = useState(false);
  const [libraryValidationError, setLibraryValidationError] = useState<string | null>(null);

  function loadHealth() {
    api.get<HealthReport>("/system/health").then(setHealth);
  }

  async function saveSetting(key: string, value: string) {
    await api.put(`/settings/${key}`, { value });
    setSettings((prev) => ({ ...prev, [key]: value }));
  }

  function loadGroupStats() {
    setGroupStatsLoading(true);
    api
      .get<ReleaseGroupStatsRow[]>("/system/release-group-stats")
      .then(setGroupStats)
      .finally(() => setGroupStatsLoading(false));
  }

  async function runLibraryValidation() {
    setLibraryValidationLoading(true);
    setLibraryValidationError(null);
    try {
      const result = await api.get<LibraryMismatch[]>("/system/library-validation");
      setLibraryMismatches(result);
    } catch (e) {
      setLibraryValidationError((e as Error).message);
      setLibraryMismatches(null);
    } finally {
      setLibraryValidationLoading(false);
    }
  }

  function loadLogs() {
    setLogsLoading(true);
    const params = new URLSearchParams();
    if (logLevelFilter) params.set("level", logLevelFilter);
    if (logSearch.trim()) params.set("search", logSearch.trim());
    api
      .get<LogEntry[]>(`/system/logs${params.toString() ? `?${params.toString()}` : ""}`)
      .then(setLogs)
      .finally(() => setLogsLoading(false));
  }

  function downloadLogs() {
    if (!logs) return;
    const text = logs.map((l) => `[${l.timestamp}] ${l.level.toUpperCase()} ${l.message}`).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `aonarr-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function loadLogFiles() {
    api.get<LogFile[]>("/system/log-files").then(setLogFiles);
  }

  async function runUpdateCheck() {
    setCheckingUpdate(true);
    setUpdateCheckError(null);
    try {
      setUpdateCheck(await api.get<UpdateCheckResult>("/system/update-check"));
    } catch (e) {
      setUpdateCheckError((e as Error).message);
    } finally {
      setCheckingUpdate(false);
    }
  }

  useEffect(() => {
    api.get<SystemStatus>("/system/status").then(setStatus);
    loadHealth();
    loadLogFiles();
    api.get<Record<string, string>>("/settings").then(setSettings);
  }, []);

  // Polled separately from /system/status (which also writes disk-usage samples and statfs's
  // every root folder) so the "live" feel doesn't come at the cost of hammering those on a timer.
  useEffect(() => {
    const load = () => api.get<SystemResources>("/system/resources").then(setResources);
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  function loadUpcomingArchivals() {
    setLoadingUpcoming(true);
    api
      .get<ArchivalCandidate[]>("/system/archival/upcoming")
      .then(setUpcomingArchivals)
      .finally(() => setLoadingUpcoming(false));
  }

  async function runArchivalNow() {
    setArchiving(true);
    try {
      await api.post("/system/archival/run", {});
      notify.success("Archival run complete — check the media items that had files for changes.");
      if (upcomingArchivals) loadUpcomingArchivals();
    } finally {
      setArchiving(false);
    }
  }

  async function runTraktSyncNow() {
    setSyncingTrakt(true);
    try {
      const result = await api.post<{ added: number; error?: string }>("/system/trakt-sync/run", {});
      if (result.error) notify.error(`Trakt sync failed: ${result.error}`);
      else notify.success(`Trakt sync added ${result.added} new item(s).`);
    } finally {
      setSyncingTrakt(false);
    }
  }

  async function runPlexWatchlistSyncNow() {
    setSyncingPlexWatchlist(true);
    try {
      const result = await api.post<{ added: number; error?: string }>("/system/plex-watchlist-sync/run", {});
      if (result.error) notify.error(`Plex watchlist sync failed: ${result.error}`);
      else notify.success(`Plex watchlist sync added ${result.added} new item(s).`);
    } finally {
      setSyncingPlexWatchlist(false);
    }
  }

  async function runRenameFiles() {
    if (
      !(await confirmDialog({
        title: "Rename files",
        message: "Rename every already-imported file whose current path no longer matches its naming template? Files are moved on disk, not just relabeled in the database.",
        danger: true,
      }))
    )
      return;
    setRenaming(true);
    setRenameResult(null);
    try {
      const qs = renameType ? `?type=${renameType}` : "";
      const result = await api.post<{
        renamed: { title: string; from: string; to: string }[];
        errors: { title: string; error: string }[];
        skippedMusic: number;
      }>(`/media/rename-files${qs}`, {});
      setRenameResult(result);
    } finally {
      setRenaming(false);
    }
  }

  async function loadUnmonitoredNoFile() {
    setCleanupLoading("unmonitored");
    try {
      const result = await api.get<UnmonitoredNoFileItem[]>("/system/cleanup/unmonitored");
      setUnmonitoredNoFile(result);
    } finally {
      setCleanupLoading(null);
    }
  }

  async function deleteUnmonitoredNoFile(id: number) {
    await api.del(`/media/${id}`);
    setUnmonitoredNoFile((prev) => prev?.filter((i) => i.id !== id) ?? null);
  }

  async function deleteAllUnmonitoredNoFile() {
    if (!unmonitoredNoFile || unmonitoredNoFile.length === 0) return;
    if (
      !(await confirmDialog({
        title: "Delete items",
        message: `Delete all ${unmonitoredNoFile.length} unmonitored, fileless item(s)? This cannot be undone.`,
        danger: true,
      }))
    )
      return;
    setDeletingAllUnmonitored(true);
    // Removed from state as each delete actually succeeds, and one failure doesn't abort the rest
    // — the old unconditional `for` loop threw on the first error and never reached
    // setUnmonitoredNoFile([]), leaving already-deleted items still listed with no error shown,
    // and re-clicking would re-attempt deletes on rows already gone server-side.
    const failures: string[] = [];
    for (const item of unmonitoredNoFile) {
      try {
        await api.del(`/media/${item.id}`);
        setUnmonitoredNoFile((prev) => prev?.filter((i) => i.id !== item.id) ?? null);
      } catch (e) {
        failures.push(`${item.title}: ${(e as Error).message}`);
      }
    }
    setDeletingAllUnmonitored(false);
    if (failures.length > 0) notify.error(`${failures.length} item(s) failed to delete:\n${failures.join("\n")}`);
  }

  async function loadDuplicateFiles() {
    setCleanupLoading("duplicates");
    try {
      const result = await api.get<DuplicateFileGroup[]>("/system/cleanup/duplicate-files");
      setDuplicateFiles(result);
    } finally {
      setCleanupLoading(null);
    }
  }

  async function scanLibraryNow() {
    setScanningLibrary(true);
    try {
      await api.post("/jobs/libraryScan/run", {});
      notify.info(
        "Library scan started in the background — check the Jobs page or your library after a minute for anything newly matched/imported.",
        7000
      );
    } finally {
      setScanningLibrary(false);
    }
  }

  async function scanOrphaned(full: boolean) {
    setScanning(true);
    try {
      const result = await api.get<{ orphaned: OrphanedFile[]; incremental: boolean }>(
        `/system/orphaned-scan${full ? "?full=1" : ""}`
      );
      setOrphaned(result.orphaned);
      setOrphanedIncremental(result.incremental);
    } finally {
      setScanning(false);
    }
  }

  async function downloadBackup() {
    setBackingUp(true);
    try {
      await downloadFile("/system/backup", "aonarr-backup.aonarrbackup");
    } finally {
      setBackingUp(false);
    }
  }

  async function restoreBackup(file: File) {
    if (
      !(await confirmDialog({
        title: "Restore backup",
        message: `Restore from "${file.name}"? This replaces the entire database (a copy of the current one is kept as a safety net) and restarts the app.`,
        danger: true,
      }))
    ) {
      if (restoreInputRef.current) restoreInputRef.current.value = "";
      return;
    }
    setRestoring(true);
    try {
      const bytes = await file.arrayBuffer();
      await uploadRaw("/system/backup/restore", bytes);
      notify.info("Restore in progress — the app is restarting. Reload this page in a few seconds.", 8000);
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setRestoring(false);
      if (restoreInputRef.current) restoreInputRef.current.value = "";
    }
  }

  if (!status) return <p className="empty">Loading...</p>;

  return (
    <div>
      <h1>System</h1>

      <div className="settings-tabs" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
        {[
          ["overview", "Overview"],
          ["health", "Health"],
          ["backups", "Backups"],
          ["maintenance", "Maintenance"],
          ["insights", "Insights"],
          ["logs", "Logs"],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? "" : "secondary"}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={{ display: tab === "overview" ? undefined : "none" }}>
      <h2>Overview</h2>
      <table>
        <tbody>
          <tr>
            <th>AoNarr version</th>
            <td>{status.version}</td>
          </tr>
          <tr>
            <th>Node.js</th>
            <td>{status.nodeVersion}</td>
          </tr>
          <tr>
            <th>Platform</th>
            <td>{status.platform}</td>
          </tr>
          <tr>
            <th>Uptime</th>
            <td>{formatUptime(status.uptimeSeconds)}</td>
          </tr>
          <tr>
            <th>CPU load (1 / 5 / 15 min)</th>
            <td>
              {resources
                ? resources.loadAvg.every((n) => n === 0)
                  ? "not available on this platform"
                  : resources.loadAvg.map((n) => n.toFixed(2)).join(" / ")
                : "-"}
            </td>
          </tr>
          <tr>
            <th>Memory</th>
            <td>
              {resources ? (
                <>
                  {formatBytes(resources.memory.usedBytes)} / {formatBytes(resources.memory.totalBytes)} ({resources.memory.usedPercent}%)
                  <div style={{ background: "var(--border)", borderRadius: 4, height: 6, marginTop: 4, maxWidth: 240, overflow: "hidden" }}>
                    <div
                      style={{
                        width: `${resources.memory.usedPercent}%`,
                        height: "100%",
                        background: resources.memory.usedPercent >= 90 ? "var(--danger)" : "var(--accent)",
                      }}
                    />
                  </div>
                </>
              ) : (
                "-"
              )}
            </td>
          </tr>
          <tr>
            <th>Enabled indexers</th>
            <td>{status.indexerCount}</td>
          </tr>
          <tr>
            <th>Enabled download clients</th>
            <td>{status.downloadClientCount}</td>
          </tr>
          <tr>
            <th>Active queue items</th>
            <td>{status.queueCount}</td>
          </tr>
        </tbody>
      </table>

      <h2>Updates</h2>
      <div className="form-panel">
        <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
          AoNarr ships as a rolling build (no numbered releases), so this compares the changelog
          round this container was built from against the latest one on GitHub's main branch —
          not a semver check. A newer round means new code to pull (rebuild/pull a fresh image),
          not something this button can install for you.
        </p>
        <button className="secondary" onClick={runUpdateCheck} disabled={checkingUpdate}>
          {checkingUpdate ? "Checking..." : "Check for updates"}
        </button>
        {updateCheckError && <p style={{ color: "var(--danger)" }}>{updateCheckError}</p>}
        {updateCheck && (
          <p style={{ marginTop: 10 }}>
            Running: Round {updateCheck.currentRound ?? "?"}
            {updateCheck.currentTitle ? ` — ${updateCheck.currentTitle}` : ""}
            <br />
            Latest on GitHub: Round {updateCheck.latestRound ?? "?"}
            {updateCheck.latestTitle ? ` — ${updateCheck.latestTitle}` : ""}
            <br />
            {updateCheck.updateAvailable ? (
              <span className="badge danger" style={{ marginTop: 4, display: "inline-block" }}>
                Update available — see What's New for details
              </span>
            ) : (
              <span className="badge ok" style={{ marginTop: 4, display: "inline-block" }}>
                Up to date
              </span>
            )}
          </p>
        )}
      </div>

      <h2>Library</h2>
      <table>
        <thead>
          <tr>
            <th>Movies</th>
            <th>Series</th>
            <th>Artists</th>
            <th>Authors</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{status.libraryCounts.movie ?? 0}</td>
            <td>{status.libraryCounts.series ?? 0}</td>
            <td>{status.libraryCounts.artist ?? 0}</td>
            <td>{status.libraryCounts.author ?? 0}</td>
          </tr>
        </tbody>
      </table>

      </div>
      <div style={{ display: tab === "health" ? undefined : "none" }}>
      <h2>Health</h2>
      {!health && <p className="empty">Loading...</p>}
      {health && (
        <>
          {health.configWarnings.length > 0 && (
            <div className="form-panel" style={{ borderColor: "var(--danger)", marginBottom: 16 }}>
              {health.configWarnings.map((w) => (
                <p key={w.key} style={{ color: "var(--danger)", margin: "4px 0" }}>
                  ⚠ {w.message}
                </p>
              ))}
            </div>
          )}

          <table>
            <thead>
              <tr>
                {indexerHealthHeader("indexer", "Indexer")}
                {indexerHealthHeader("status", "Status")}
                {indexerHealthHeader("rate", "Recent success rate")}
              </tr>
            </thead>
            <tbody>
              {sortIndexerHealth(health.indexers, (a, b, key) => {
                if (key === "indexer") return a.name.localeCompare(b.name);
                if (key === "status") return Number(b.ok) - Number(a.ok);
                return (a.recent?.successRate ?? -1) - (b.recent?.successRate ?? -1);
              }).map((i) => (
                <tr key={i.id}>
                  <td>{i.name}</td>
                  <td>
                    <span className={`badge ${i.ok ? "ok" : "danger"}`}>
                      {i.ok ? "Reachable" : `Unreachable${i.error ? ` (${i.error})` : ""}`}
                    </span>
                  </td>
                  <td title={i.recent?.lastError ?? undefined}>
                    {i.recent && i.recent.totalChecks > 0 ? (
                      <span className={`badge ${(i.recent.successRate ?? 0) >= 80 ? "ok" : (i.recent.successRate ?? 0) > 0 ? "" : "danger"}`}>
                        {i.recent.successRate}% ({i.recent.totalChecks}){i.recent.avgResponseTimeMs != null ? ` · ${i.recent.avgResponseTimeMs}ms` : ""}
                      </span>
                    ) : (
                      <span className="sub">No checks yet</span>
                    )}
                  </td>
                </tr>
              ))}
              {health.indexers.length === 0 && (
                <tr>
                  <td colSpan={3} className="empty">
                    No enabled indexers.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {health.downloadClients.length > 0 && (
            <table style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  {clientHealthHeader("client", "Download Client")}
                  {clientHealthHeader("status", "Status")}
                </tr>
              </thead>
              <tbody>
                {sortClientHealth(health.downloadClients, (a, b, key) =>
                  key === "client" ? a.name.localeCompare(b.name) : Number(b.ok) - Number(a.ok)
                ).map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td>
                      <span className={`badge ${c.ok ? "ok" : "danger"}`}>{c.ok ? "Reachable" : c.error ?? "Unreachable"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {health.diskWarnings.length > 0 && (
            <p style={{ marginTop: 12, color: "var(--danger)" }}>
              Low disk space: {health.diskWarnings.map((w) => `${w.path} (${w.percentFree}% free)`).join(", ")}
            </p>
          )}

          <p style={{ marginTop: 12 }}>
            <strong>{health.stuckQueue.length}</strong> queue item(s) stuck longer than{" "}
            {health.stuckQueueThresholdHours}h · <strong>{health.pendingRequests}</strong> pending request(s)
            <button type="button" className="icon-button" style={{ marginLeft: 10, width: 26, height: 26 }} onClick={loadHealth} title="Refresh" aria-label="Refresh">
              <RotateCcwIcon />
            </button>
          </p>
          {health.stuckQueue.length > 0 && (
            <table>
              <thead>
                <tr>
                  {stuckQueueHeader("media", "Media")}
                  {stuckQueueHeader("release", "Release")}
                  {stuckQueueHeader("status", "Status")}
                  {stuckQueueHeader("added", "Added")}
                </tr>
              </thead>
              <tbody>
                {sortStuckQueue(health.stuckQueue, (a, b, key) => {
                  if (key === "media") return a.mediaTitle.localeCompare(b.mediaTitle);
                  if (key === "release") return a.title.localeCompare(b.title);
                  if (key === "status") return a.status.localeCompare(b.status);
                  return a.addedAt.localeCompare(b.addedAt);
                }).map((q) => (
                  <tr key={q.id}>
                    <td>{q.mediaTitle}</td>
                    <td>{q.title}</td>
                    <td>{q.status}</td>
                    <td>{q.addedAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {health.repeatedImports.length > 0 && (
            <>
              <h3 style={{ marginBottom: 4 }}>Repeated imports (possible upgrades or duplicates)</h3>
              <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
                Imported more than once — a rising quality sequence is a normal upgrade; the same
                quality twice usually means a wasted duplicate grab worth cleaning up on disk.
              </p>
              <table>
                <thead>
                  <tr>
                    {repeatedImportsHeader("item", "Item")}
                    {repeatedImportsHeader("count", "Times imported")}
                    <th>Quality history</th>
                  </tr>
                </thead>
                <tbody>
                  {sortRepeatedImports(health.repeatedImports, (a, b, key) =>
                    key === "item" ? a.target.localeCompare(b.target) : a.importCount - b.importCount
                  ).map((r) => (
                    <tr key={`${r.mediaItemId}-${r.target}`}>
                      <td>{r.target}</td>
                      <td>{r.importCount}</td>
                      <td>{r.qualities.map((q) => q ?? "unknown").join(" → ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {health.upgradeCandidates.length > 0 && (
            <>
              <h3 style={{ marginBottom: 4 }}>Upgrade candidates</h3>
              <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
                Downloaded below their quality profile's current cutoff — profiles can change
                after a file was imported, and nothing re-checks old downloads automatically.
              </p>
              <table>
                <thead>
                  <tr>
                    {upgradeCandidatesHeader("item", "Item")}
                    {upgradeCandidatesHeader("current", "Current quality")}
                    {upgradeCandidatesHeader("cutoff", "Profile cutoff")}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sortUpgradeCandidates(health.upgradeCandidates, (a, b, key) => {
                    if (key === "item") return a.target.localeCompare(b.target);
                    if (key === "current") return a.currentQuality.localeCompare(b.currentQuality);
                    return a.cutoff.localeCompare(b.cutoff);
                  }).map((u) => (
                    <tr key={`${u.mediaItemId}-${u.target}`}>
                      <td>{u.target}</td>
                      <td>{u.currentQuality}</td>
                      <td>
                        {u.cutoff} <span style={{ color: "var(--muted)" }}>({u.profileName})</span>
                      </td>
                      <td>
                        <button type="button" className="icon-button" onClick={() => navigate(`/media/${u.mediaItemId}`)} title="Open" aria-label="Open">
                          <ArrowRightIcon />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      </div>
      <div style={{ display: tab === "backups" ? undefined : "none" }}>
      <SettingsSectionTiles
        sections={[
          {
            key: "backupRestore",
            label: "Backup & Restore",
            description: "Download or restore a full database snapshot",
            render: () => (
              <div>
                <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
                  The backup is a full snapshot of the database — library, settings, indexers, quality
                  profiles, users, everything except files on disk — bundled with the encryption key
                  used to protect stored credentials (API keys, download-client and SMTP passwords,
                  webhook URLs), so a restore onto a different install can still read them. Restoring
                  replaces the running database and restarts the app; the database in place just before
                  a restore is always kept as a <code>.pre-restore</code> copy. Older single-file{" "}
                  <code>.db</code>/<code>.dump</code> backups from before bundling still restore fine —
                  they just won't carry a key, so credentials saved after that backup was made would
                  need re-entering.
                </p>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="icon-button" onClick={downloadBackup} disabled={backingUp} title={backingUp ? "Preparing..." : "Download backup"} aria-label="Download backup">
                    <DownloadIcon />
                  </button>
                  <button
                    type="button"
                    className="icon-button danger"
                    onClick={() => restoreInputRef.current?.click()}
                    disabled={restoring}
                    title={restoring ? "Restoring..." : "Restore from backup..."}
                    aria-label="Restore from backup"
                  >
                    <InboxIcon />
                  </button>
                  <input
                    ref={restoreInputRef}
                    type="file"
                    accept=".aonarrbackup,.db,.dump"
                    style={{ display: "none" }}
                    onChange={(e) => e.target.files?.[0] && restoreBackup(e.target.files[0])}
                  />
                </div>
              </div>
            ),
          },
          {
            key: "scheduledBackups",
            label: "Scheduled Backups",
            description: "Periodic local + optional S3 backups",
            badge: settings.backupEnabled === "1" ? "Enabled" : "Disabled",
            badgeOk: settings.backupEnabled === "1",
            render: () => (
              <div>
                <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
                  Periodically writes a timestamped copy of the same database snapshot into a folder on
                  disk (e.g. a mapped Unraid share), keeping only the most recent N copies. Runs on an
                  hourly check, so a new backup lands within an hour of the configured interval elapsing.
                </p>
                <label htmlFor="system-enable-scheduled-backups-1">Enable scheduled backups</label>
                <select id="system-enable-scheduled-backups-1"
                  key={settings.backupEnabled ?? "backup-enabled-empty"}
                  defaultValue={settings.backupEnabled ?? "0"}
                  onChange={(e) => saveSetting("backupEnabled", e.target.value)}
                >
                  <option value="0">Disabled</option>
                  <option value="1">Enabled</option>
                </select>
                <label htmlFor="system-backup-dir">Backup directory (path inside the container)</label>
                <div className="toolbar">
                  <input
                    id="system-backup-dir"
                    key={settings.backupDir ?? "backup-dir-empty"}
                    defaultValue={settings.backupDir ?? ""}
                    placeholder="/backups"
                    onBlur={(e) => saveSetting("backupDir", e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button type="button" className="icon-button" onClick={() => setShowBackupDirPicker(true)} title="Browse..." aria-label="Browse for a folder">
                    <FolderIcon />
                  </button>
                </div>
                {showBackupDirPicker && (
                  <FolderPicker
                    initialPath={settings.backupDir || "/"}
                    onClose={() => setShowBackupDirPicker(false)}
                    onSelect={(p) => {
                      saveSetting("backupDir", p);
                      setShowBackupDirPicker(false);
                    }}
                  />
                )}
                <label htmlFor="system-interval-hours-2">Interval (hours)</label>
                <input id="system-interval-hours-2"
                  type="number"
                  min={1}
                  style={{ maxWidth: 120 }}
                  key={settings.backupIntervalHours ?? "backup-interval-empty"}
                  defaultValue={settings.backupIntervalHours ?? "24"}
                  onBlur={(e) => saveSetting("backupIntervalHours", e.target.value)}
                />
                <label htmlFor="system-keep-last-n-backups-3">Keep last N backups</label>
                <input id="system-keep-last-n-backups-3"
                  type="number"
                  min={1}
                  style={{ maxWidth: 120 }}
                  key={settings.backupKeepCount ?? "backup-keep-empty"}
                  defaultValue={settings.backupKeepCount ?? "7"}
                  onBlur={(e) => saveSetting("backupKeepCount", e.target.value)}
                />

                <p style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
                  Optionally also upload each scheduled backup to an S3-compatible bucket (AWS S3, MinIO,
                  Backblaze B2, etc.) so it survives the host itself dying, not just a bad DB write. Uses
                  the same interval/keep-count above; remote objects are rotated the same way.
                </p>
                <label htmlFor="system-upload-to-s3-4">Upload to S3</label>
                <select id="system-upload-to-s3-4"
                  key={settings.s3Enabled ?? "s3-enabled-empty"}
                  defaultValue={settings.s3Enabled ?? "0"}
                  onChange={(e) => saveSetting("s3Enabled", e.target.value)}
                >
                  <option value="0">Disabled</option>
                  <option value="1">Enabled</option>
                </select>
                <label htmlFor="system-bucket-5">Bucket</label>
                <input id="system-bucket-5"
                  key={settings.s3Bucket ?? "s3-bucket-empty"}
                  defaultValue={settings.s3Bucket ?? ""}
                  placeholder="my-aonarr-backups"
                  onBlur={(e) => saveSetting("s3Bucket", e.target.value)}
                />
                <label htmlFor="system-region-6">Region</label>
                <input id="system-region-6"
                  key={settings.s3Region ?? "s3-region-empty"}
                  defaultValue={settings.s3Region ?? ""}
                  placeholder="us-east-1"
                  onBlur={(e) => saveSetting("s3Region", e.target.value)}
                />
                <label htmlFor="system-custom-endpoint-blank-for-aws-s3-set-for-7">Custom endpoint (blank for AWS S3; set for MinIO/B2/etc.)</label>
                <input id="system-custom-endpoint-blank-for-aws-s3-set-for-7"
                  key={settings.s3Endpoint ?? "s3-endpoint-empty"}
                  defaultValue={settings.s3Endpoint ?? ""}
                  placeholder="https://s3.us-west-000.backblazeb2.com"
                  onBlur={(e) => saveSetting("s3Endpoint", e.target.value)}
                />
                <label htmlFor="system-access-key-id-8">Access key ID</label>
                <input id="system-access-key-id-8"
                  key={settings.s3AccessKeyId ?? "s3-access-key-empty"}
                  defaultValue={settings.s3AccessKeyId ?? ""}
                  onBlur={(e) => saveSetting("s3AccessKeyId", e.target.value)}
                />
                <label htmlFor="system-secret-access-key-9">Secret access key</label>
                <input id="system-secret-access-key-9"
                  type="password"
                  key={settings.s3SecretAccessKey ?? "s3-secret-key-empty"}
                  defaultValue={settings.s3SecretAccessKey ?? ""}
                  onBlur={(e) => saveSetting("s3SecretAccessKey", e.target.value)}
                />
                <label htmlFor="system-key-prefix-optional-folder-path-within-t-10">Key prefix (optional folder path within the bucket)</label>
                <input id="system-key-prefix-optional-folder-path-within-t-10"
                  key={settings.s3Prefix ?? "s3-prefix-empty"}
                  defaultValue={settings.s3Prefix ?? ""}
                  placeholder="aonarr-backups"
                  onBlur={(e) => saveSetting("s3Prefix", e.target.value)}
                />
              </div>
            ),
          },
        ]}
      />
      </div>
      <div style={{ display: tab === "maintenance" ? undefined : "none" }}>
      <h2>Maintenance</h2>
      <div className="form-panel">
        <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
          Manually trigger the watch-status auto-archival pass (normally runs every 6 hours), or
          scan root folders for files on disk that AoNarr doesn't know about — nothing is deleted
          automatically by the scan itself.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={runArchivalNow} disabled={archiving} className="secondary">
            {archiving ? "Running..." : "Run archival now"}
          </button>
          <button
            onClick={scanLibraryNow}
            disabled={scanningLibrary}
            className="secondary"
            title="Matches files already sitting in your root folders to library items (adding new ones as needed) — for discovering an existing, already-organized library instead of re-adding everything by hand."
          >
            {scanningLibrary ? "Scanning..." : "Scan library for existing files"}
          </button>
          <button onClick={() => scanOrphaned(false)} disabled={scanning} className="secondary">
            {scanning ? "Scanning..." : "Scan for orphaned files"}
          </button>
          <button onClick={() => scanOrphaned(true)} disabled={scanning} className="secondary">
            {scanning ? "Scanning..." : "Full orphaned-file scan"}
          </button>
          <button onClick={runTraktSyncNow} disabled={syncingTrakt} className="secondary">
            {syncingTrakt ? "Syncing..." : "Run Trakt sync now"}
          </button>
          <button onClick={runPlexWatchlistSyncNow} disabled={syncingPlexWatchlist} className="secondary">
            {syncingPlexWatchlist ? "Syncing..." : "Run Plex watchlist sync now"}
          </button>
        </div>

        <h3 style={{ marginTop: 20, marginBottom: 4 }}>Leaving Soon</h3>
        <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
          A preview of what the next auto-archival run will sweep up — nothing here has been
          touched yet. Rewatching something pushes it back down this list automatically, since the
          date shown is recalculated live from your media server's watch status every time this
          loads.
        </p>
        {!upcomingArchivals && (
          <button onClick={loadUpcomingArchivals} disabled={loadingUpcoming} className="secondary">
            {loadingUpcoming ? "Loading..." : "Show upcoming archivals"}
          </button>
        )}
        {upcomingArchivals && (
          <>
            <button onClick={loadUpcomingArchivals} disabled={loadingUpcoming} className="secondary" style={{ marginBottom: 8 }}>
              {loadingUpcoming ? "Refreshing..." : "Refresh"}
            </button>
            {upcomingArchivals.length === 0 && <p className="empty">Nothing scheduled — either archival is off, no media server is configured, or nothing's eligible yet.</p>}
            {upcomingArchivals.length > 0 && (
              <table>
                <thead>
                  <tr>
                    {archivalsHeader("title", "Title")}
                    {archivalsHeader("type", "Type")}
                    {archivalsHeader("scheduled", "Scheduled for")}
                  </tr>
                </thead>
                <tbody>
                  {sortArchivals(upcomingArchivals, (a, b, key) => {
                    if (key === "title") return a.title.localeCompare(b.title);
                    if (key === "type") return a.type.localeCompare(b.type);
                    return a.scheduledFor.localeCompare(b.scheduledFor);
                  }).map((c) => (
                    <tr key={`${c.mediaItemId}-${c.filePath}`}>
                      <td>{c.title}</td>
                      <td>{c.type}</td>
                      <td>{new Date(c.scheduledFor).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
        {orphaned && (
          <>
            <p style={{ marginTop: 12 }}>
              {orphaned.length} orphaned file(s) found
              {orphanedIncremental && " (incremental — only folders changed since the last scan; run a full scan for a complete list)"}.
            </p>
            {orphaned.length > 0 && (
              <table>
                <thead>
                  <tr>
                    {orphanedHeader("path", "Path")}
                    {orphanedHeader("size", "Size")}
                  </tr>
                </thead>
                <tbody>
                  {sortOrphaned(orphaned, (a, b, key) => (key === "path" ? a.path.localeCompare(b.path) : a.sizeBytes - b.sizeBytes)).map((o) => (
                    <tr key={o.path}>
                      <td>{o.path}</td>
                      <td>{formatBytes(o.sizeBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>

      <h2>Rename Files</h2>
      <div className="form-panel">
        <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
          Retroactively re-renames every already-imported file whose current path no longer
          matches its library type's naming template (Settings → Media Management → Naming) — for
          after you've changed a template and want existing files to catch up, not just new
          imports. Files with no change needed are skipped; Music is skipped entirely since its
          track filenames are always kept as-downloaded rather than templated.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select value={renameType} onChange={(e) => setRenameType(e.target.value)} style={{ maxWidth: 220 }}>
            <option value="">All library types</option>
            {mediaTypes.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
          <button onClick={runRenameFiles} disabled={renaming} className="secondary">
            {renaming ? "Renaming..." : "Rename files now"}
          </button>
        </div>
        {renameResult && (
          <div style={{ marginTop: 12 }}>
            <p>
              {renameResult.renamed.length} file(s) renamed
              {renameResult.skippedMusic > 0 && `, ${renameResult.skippedMusic} Music file(s) skipped`}
              {renameResult.errors.length > 0 && `, ${renameResult.errors.length} error(s)`}.
            </p>
            {renameResult.renamed.length > 0 && (
              <table>
                <thead>
                  <tr>
                    {renamedHeader("title", "Title")}
                    {renamedHeader("to", "New path")}
                  </tr>
                </thead>
                <tbody>
                  {sortRenamed(renameResult.renamed, (a, b, key) =>
                    key === "title" ? a.title.localeCompare(b.title) : a.to.localeCompare(b.to)
                  ).map((r, i) => (
                    <tr key={i}>
                      <td>{r.title}</td>
                      <td style={{ fontFamily: "monospace", fontSize: "0.8rem", wordBreak: "break-all" }}>{r.to}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {renameResult.errors.length > 0 && (
              <table style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    {renameErrorsHeader("title", "Title")}
                    {renameErrorsHeader("error", "Error")}
                  </tr>
                </thead>
                <tbody>
                  {sortRenameErrors(renameResult.errors, (a, b, key) =>
                    key === "title" ? a.title.localeCompare(b.title) : a.error.localeCompare(b.error)
                  ).map((e, i) => (
                    <tr key={i}>
                      <td>{e.title}</td>
                      <td style={{ color: "var(--danger)" }}>{e.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      <h2>Cleanup Suggestions</h2>
      <div className="form-panel">
        <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
          On-demand suggestions only — nothing here runs automatically or deletes anything without
          you clicking a button.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={loadUnmonitoredNoFile} disabled={cleanupLoading === "unmonitored"} className="secondary">
            {cleanupLoading === "unmonitored" ? "Checking..." : "Find unmonitored + no file"}
          </button>
          <button onClick={loadDuplicateFiles} disabled={cleanupLoading === "duplicates"} className="secondary">
            {cleanupLoading === "duplicates" ? "Scanning..." : "Find duplicate files"}
          </button>
        </div>

        {unmonitoredNoFile && (
          <>
            <p style={{ marginTop: 12 }}>
              {unmonitoredNoFile.length} unmonitored item(s) with no downloaded file — safe to
              delete outright.
            </p>
            {unmonitoredNoFile.length > 0 && (
              <>
                <button className="danger" onClick={deleteAllUnmonitoredNoFile} disabled={deletingAllUnmonitored} style={{ marginBottom: 8 }}>
                  {deletingAllUnmonitored ? "Deleting..." : `Delete all ${unmonitoredNoFile.length}`}
                </button>
                <table>
                  <thead>
                    <tr>
                      {unmonitoredNoFileHeader("title", "Title")}
                      {unmonitoredNoFileHeader("type", "Type")}
                      {unmonitoredNoFileHeader("added", "Added")}
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortUnmonitoredNoFile(unmonitoredNoFile, (a, b, key) => {
                      if (key === "title") return a.title.localeCompare(b.title);
                      if (key === "type") return a.type.localeCompare(b.type);
                      return a.addedAt.localeCompare(b.addedAt);
                    }).map((i) => (
                      <tr key={i.id}>
                        <td>
                          {i.title}
                          {i.year ? ` (${i.year})` : ""}
                        </td>
                        <td>{i.type}</td>
                        <td>{i.addedAt}</td>
                        <td>
                          <button type="button" className="icon-button danger" onClick={() => deleteUnmonitoredNoFile(i.id)} title="Delete" aria-label="Delete">
                            <TrashIcon />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}

        {duplicateFiles && (
          <>
            <p style={{ marginTop: 12 }}>
              {duplicateFiles.length} likely-duplicate group(s) found (same size + matching content
              sample) — review before deleting either copy yourself; AoNarr doesn't delete files here.
            </p>
            {duplicateFiles.map((g, idx) => (
              <div key={idx} style={{ marginBottom: 12 }}>
                <strong>{formatBytes(g.sizeBytes)}</strong>
                <table>
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Path</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.files.map((f) => (
                      <tr key={f.path}>
                        <td>
                          <a onClick={() => navigate(`/media/${f.mediaItemId}`)} style={{ cursor: "pointer" }}>
                            {f.label}
                          </a>
                        </td>
                        <td>{f.path}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </>
        )}
      </div>

      </div>
      <div style={{ display: tab === "insights" ? undefined : "none" }}>
      <h2>Release Group Reputation</h2>
      <div className="form-panel">
        <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
          Success/failure history per release group, built up from every import and every
          automatic retry — used as a tiebreaker when multiple search results tie on quality and
          format score. A group needs at least 3 known outcomes before its rate affects ranking.
        </p>
        <button className="secondary" onClick={loadGroupStats} disabled={groupStatsLoading}>
          {groupStatsLoading ? "Loading..." : "Load reputation stats"}
        </button>
        {groupStats && groupStats.length === 0 && <p className="empty">No grab history yet.</p>}
        {groupStats && groupStats.length > 0 && (
          <table style={{ marginTop: 12 }}>
            <thead>
              <tr>
                {groupStatsHeader("group", "Release group")}
                {groupStatsHeader("successes", "Successes")}
                {groupStatsHeader("failures", "Failures")}
                {groupStatsHeader("rate", "Success rate")}
              </tr>
            </thead>
            <tbody>
              {sortGroupStats(groupStats, (a, b, key) => {
                if (key === "group") return a.releaseGroup.localeCompare(b.releaseGroup);
                if (key === "successes") return a.successes - b.successes;
                if (key === "failures") return a.failures - b.failures;
                return a.successRate - b.successRate;
              }).map((g) => (
                <tr key={g.releaseGroup}>
                  <td>{g.releaseGroup}</td>
                  <td>{g.successes}</td>
                  <td>{g.failures}</td>
                  <td>{Math.round(g.successRate * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Media Server Library Validation</h2>
      <div className="form-panel">
        <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
          Compares AoNarr's own movie/episode library against what the configured media server
          (Plex/Jellyfin/Emby) actually reports having — flags anything AoNarr thinks exists but
          the media server doesn't see (a stale path, a permissions issue, a file moved or deleted
          outside AoNarr). Needs a media server configured above.
        </p>
        <button className="secondary" onClick={runLibraryValidation} disabled={libraryValidationLoading}>
          {libraryValidationLoading ? "Checking..." : "Run validation"}
        </button>
        {libraryValidationError && <p style={{ color: "var(--danger)" }}>{libraryValidationError}</p>}
        {libraryMismatches && libraryMismatches.length === 0 && (
          <p style={{ marginTop: 12 }}>Everything AoNarr has matches what the media server sees.</p>
        )}
        {libraryMismatches && libraryMismatches.length > 0 && (
          <>
            <p style={{ marginTop: 12 }}>{libraryMismatches.length} item(s) AoNarr has that the media server doesn't see:</p>
            <table>
              <thead>
                <tr>
                  {mismatchesHeader("item", "Item")}
                  {mismatchesHeader("path", "Path")}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sortMismatches(libraryMismatches, (a, b, key) =>
                  key === "item" ? a.label.localeCompare(b.label) : a.path.localeCompare(b.path)
                ).map((m, idx) => (
                  <tr key={idx}>
                    <td>{m.label}</td>
                    <td>{m.path}</td>
                    <td>
                      <button type="button" className="icon-button" onClick={() => navigate(`/media/${m.mediaItemId}`)} title="Open" aria-label="Open">
                        <ArrowRightIcon />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <h2>Disk Space</h2>
      <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
        "Est. days until full" trends free space from daily samples (one per root folder) — needs
        at least a day or two of history before it appears.
      </p>
      {status.diskSpace.length === 0 && <p className="empty">No root folders configured.</p>}
      {status.diskSpace.length > 0 && (
        <table>
          <thead>
            <tr>
              {diskSpaceHeader("path", "Root folder")}
              {diskSpaceHeader("type", "Type")}
              {diskSpaceHeader("free", "Free")}
              {diskSpaceHeader("total", "Total")}
              {diskSpaceHeader("days", "Est. days until full")}
            </tr>
          </thead>
          <tbody>
            {sortDiskSpace(status.diskSpace, (a, b, key) => {
              if (key === "path") return a.path.localeCompare(b.path);
              if (key === "type") return a.mediaType.localeCompare(b.mediaType);
              if (key === "free") return (a.freeBytes ?? 0) - (b.freeBytes ?? 0);
              if (key === "total") return (a.totalBytes ?? 0) - (b.totalBytes ?? 0);
              return (a.daysUntilFull ?? Infinity) - (b.daysUntilFull ?? Infinity);
            }).map((d, idx) => (
              <tr key={idx}>
                <td>{d.path}</td>
                <td>{d.mediaType}</td>
                <td>{formatBytes(d.freeBytes)}</td>
                <td>{formatBytes(d.totalBytes)}</td>
                <td>
                  {d.daysUntilFull === null ? (
                    "-"
                  ) : (
                    <span className={`badge ${d.daysUntilFull < 30 ? "danger" : ""}`}>{d.daysUntilFull}d</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      </div>
      <div style={{ display: tab === "logs" ? undefined : "none" }}>
      <h2>Logs</h2>
      <div className="form-panel">
        <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
          The last 2000 log lines, newest first — the same output as{" "}
          <code>docker compose logs aonarr-server</code> without needing shell access.
        </p>
        <label htmlFor="system-log-verbosity-11">Log verbosity</label>
        <select id="system-log-verbosity-11"
          key={settings.logLevel ?? "log-level-empty"}
          defaultValue={settings.logLevel ?? "info"}
          onChange={(e) => saveSetting("logLevel", e.target.value)}
          style={{ width: "auto", marginBottom: 10 }}
        >
          <option value="info">Info (default) — everything</option>
          <option value="warn">Warn — only warnings and errors</option>
          <option value="error">Error — only errors</option>
        </select>
        <p style={{ color: "var(--muted)", fontSize: "0.78rem", marginTop: -6 }}>
          Controls what's kept in this log view and the daily log files — always still goes to the
          container's own stdout/stderr regardless of this setting.
        </p>
        <div className="toolbar">
          <select value={logLevelFilter} onChange={(e) => setLogLevelFilter(e.target.value)} style={{ width: "auto" }}>
            <option value="">All levels</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
          <input
            type="text"
            placeholder="Search log text..."
            value={logSearch}
            onChange={(e) => setLogSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && loadLogs()}
            style={{ width: 220 }}
          />
          <button type="button" className="icon-button" onClick={loadLogs} disabled={logsLoading} title={logsLoading ? "Loading..." : logs ? "Refresh" : "Load logs"} aria-label={logs ? "Refresh logs" : "Load logs"}>
            <RotateCcwIcon />
          </button>
          {logs && (
            <button type="button" className="icon-button" onClick={downloadLogs} title="Download .log" aria-label="Download .log">
              <DownloadIcon />
            </button>
          )}
        </div>
        {logs && (
          <div
            style={{
              marginTop: 12,
              maxHeight: 400,
              overflowY: "auto",
              fontFamily: "monospace",
              fontSize: "0.8rem",
              background: "rgba(255,255,255,0.02)",
              padding: 10,
              borderRadius: 6,
            }}
          >
            {logs.length === 0 && <p className="empty">No logs yet.</p>}
            {logs.map((l, idx) => (
              <div
                key={idx}
                style={{
                  color: l.level === "error" ? "var(--danger)" : l.level === "warn" ? "#e0b03c" : "var(--text)",
                  whiteSpace: "pre-wrap",
                  marginBottom: 2,
                }}
              >
                [{l.timestamp}] {l.level.toUpperCase()} {l.message}
              </div>
            ))}
          </div>
        )}
      </div>

      <h2>Log Files</h2>
      <div className="form-panel">
        <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
          Persistent daily log files on disk, kept for 7 days — unlike the in-memory view above,
          these survive a container restart.
        </p>
        <button type="button" className="icon-button" onClick={loadLogFiles} title="Refresh" aria-label="Refresh">
          <RotateCcwIcon />
        </button>
        {logFiles && logFiles.length === 0 && <p className="empty">No log files yet.</p>}
        {logFiles && logFiles.length > 0 && (
          <table style={{ marginTop: 8 }}>
            <thead>
              <tr>
                {logFilesHeader("file", "File")}
                {logFilesHeader("size", "Size")}
                {logFilesHeader("modified", "Last written")}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sortLogFiles(logFiles, (a, b, key) => {
                if (key === "file") return a.name.localeCompare(b.name);
                if (key === "size") return a.sizeBytes - b.sizeBytes;
                return a.modifiedAt.localeCompare(b.modifiedAt);
              }).map((f) => (
                <tr key={f.name}>
                  <td>{f.name}</td>
                  <td>{formatBytes(f.sizeBytes)}</td>
                  <td>{new Date(f.modifiedAt).toLocaleString()}</td>
                  <td>
                    <button type="button" className="icon-button" onClick={() => downloadFile(`/system/log-files/${f.name}`, f.name)} title="Download" aria-label="Download">
                      <DownloadIcon />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      </div>
    </div>
  );
}
