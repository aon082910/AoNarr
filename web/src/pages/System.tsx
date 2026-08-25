import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, downloadFile, uploadRaw } from "../api/client.js";
import FolderPicker from "../components/FolderPicker.js";
import SettingsSectionTiles from "../components/SettingsSectionTiles.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import { formatBytes } from "../utils/format.js";

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
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [orphaned, setOrphaned] = useState<OrphanedFile[] | null>(null);
  const [orphanedIncremental, setOrphanedIncremental] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [syncingTrakt, setSyncingTrakt] = useState(false);
  const [syncingPlexWatchlist, setSyncingPlexWatchlist] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameType, setRenameType] = useState("");
  const [renameResult, setRenameResult] = useState<{
    renamed: { title: string; from: string; to: string }[];
    errors: { title: string; error: string }[];
    skippedMusic: number;
  } | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const [logs, setLogs] = useState<LogEntry[] | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logLevelFilter, setLogLevelFilter] = useState("");
  const [logSearch, setLogSearch] = useState("");
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [showBackupDirPicker, setShowBackupDirPicker] = useState(false);
  const [unmonitoredNoFile, setUnmonitoredNoFile] = useState<UnmonitoredNoFileItem[] | null>(null);
  const [duplicateFiles, setDuplicateFiles] = useState<DuplicateFileGroup[] | null>(null);
  const [cleanupLoading, setCleanupLoading] = useState<"unmonitored" | "duplicates" | null>(null);
  const [groupStats, setGroupStats] = useState<ReleaseGroupStatsRow[] | null>(null);
  const [groupStatsLoading, setGroupStatsLoading] = useState(false);
  const [libraryMismatches, setLibraryMismatches] = useState<LibraryMismatch[] | null>(null);
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

  useEffect(() => {
    api.get<SystemStatus>("/system/status").then(setStatus);
    loadHealth();
    api.get<Record<string, string>>("/settings").then(setSettings);
  }, []);

  async function runArchivalNow() {
    setArchiving(true);
    try {
      await api.post("/system/archival/run", {});
      alert("Archival run complete — check the media items that had files for changes.");
    } finally {
      setArchiving(false);
    }
  }

  async function runTraktSyncNow() {
    setSyncingTrakt(true);
    try {
      const result = await api.post<{ added: number; error?: string }>("/system/trakt-sync/run", {});
      if (result.error) alert(`Trakt sync failed: ${result.error}`);
      else alert(`Trakt sync added ${result.added} new item(s).`);
    } finally {
      setSyncingTrakt(false);
    }
  }

  async function runPlexWatchlistSyncNow() {
    setSyncingPlexWatchlist(true);
    try {
      const result = await api.post<{ added: number; error?: string }>("/system/plex-watchlist-sync/run", {});
      if (result.error) alert(`Plex watchlist sync failed: ${result.error}`);
      else alert(`Plex watchlist sync added ${result.added} new item(s).`);
    } finally {
      setSyncingPlexWatchlist(false);
    }
  }

  async function runRenameFiles() {
    if (
      !confirm(
        "Rename every already-imported file whose current path no longer matches its naming template? Files are moved on disk, not just relabeled in the database."
      )
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
    if (!confirm(`Delete all ${unmonitoredNoFile.length} unmonitored, fileless item(s)? This cannot be undone.`)) return;
    for (const item of unmonitoredNoFile) {
      await api.del(`/media/${item.id}`);
    }
    setUnmonitoredNoFile([]);
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
      await downloadFile("/system/backup", "aonarr-backup.db");
    } finally {
      setBackingUp(false);
    }
  }

  async function restoreBackup(file: File) {
    if (
      !confirm(
        `Restore from "${file.name}"? This replaces the entire database (a copy of the current one is kept as a safety net) and restarts the app.`
      )
    ) {
      if (restoreInputRef.current) restoreInputRef.current.value = "";
      return;
    }
    setRestoring(true);
    try {
      const bytes = await file.arrayBuffer();
      await uploadRaw("/system/backup/restore", bytes);
      alert("Restore in progress — the app is restarting. Reload this page in a few seconds.");
    } catch (e) {
      alert((e as Error).message);
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
                <th>Indexer</th>
                <th>Status</th>
                <th>Recent success rate</th>
              </tr>
            </thead>
            <tbody>
              {health.indexers.map((i) => (
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
                  <th>Download Client</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {health.downloadClients.map((c) => (
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
            <button className="secondary" style={{ marginLeft: 10 }} onClick={loadHealth}>
              Refresh
            </button>
          </p>
          {health.stuckQueue.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Media</th>
                  <th>Release</th>
                  <th>Status</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {health.stuckQueue.map((q) => (
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
                    <th>Item</th>
                    <th>Times imported</th>
                    <th>Quality history</th>
                  </tr>
                </thead>
                <tbody>
                  {health.repeatedImports.map((r) => (
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
                    <th>Item</th>
                    <th>Current quality</th>
                    <th>Profile cutoff</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {health.upgradeCandidates.map((u) => (
                    <tr key={`${u.mediaItemId}-${u.target}`}>
                      <td>{u.target}</td>
                      <td>{u.currentQuality}</td>
                      <td>
                        {u.cutoff} <span style={{ color: "var(--muted)" }}>({u.profileName})</span>
                      </td>
                      <td>
                        <button className="secondary" onClick={() => navigate(`/media/${u.mediaItemId}`)}>
                          Open
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
                  profiles, users, everything except files on disk. Restoring replaces the running
                  database and restarts the app; the database in place just before a restore is always
                  kept as a <code>.pre-restore</code> copy.
                </p>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={downloadBackup} disabled={backingUp} className="secondary">
                    {backingUp ? "Preparing..." : "Download backup"}
                  </button>
                  <button
                    onClick={() => restoreInputRef.current?.click()}
                    disabled={restoring}
                    className="danger"
                  >
                    {restoring ? "Restoring..." : "Restore from backup..."}
                  </button>
                  <input
                    ref={restoreInputRef}
                    type="file"
                    accept=".db"
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
                <label>Enable scheduled backups</label>
                <select
                  key={settings.backupEnabled ?? "backup-enabled-empty"}
                  defaultValue={settings.backupEnabled ?? "0"}
                  onChange={(e) => saveSetting("backupEnabled", e.target.value)}
                >
                  <option value="0">Disabled</option>
                  <option value="1">Enabled</option>
                </select>
                <label>Backup directory (path inside the container)</label>
                <div className="toolbar">
                  <input
                    key={settings.backupDir ?? "backup-dir-empty"}
                    defaultValue={settings.backupDir ?? ""}
                    placeholder="/backups"
                    onBlur={(e) => saveSetting("backupDir", e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button type="button" className="secondary" onClick={() => setShowBackupDirPicker(true)}>
                    Browse...
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
                <label>Interval (hours)</label>
                <input
                  type="number"
                  min={1}
                  style={{ maxWidth: 120 }}
                  key={settings.backupIntervalHours ?? "backup-interval-empty"}
                  defaultValue={settings.backupIntervalHours ?? "24"}
                  onBlur={(e) => saveSetting("backupIntervalHours", e.target.value)}
                />
                <label>Keep last N backups</label>
                <input
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
                <label>Upload to S3</label>
                <select
                  key={settings.s3Enabled ?? "s3-enabled-empty"}
                  defaultValue={settings.s3Enabled ?? "0"}
                  onChange={(e) => saveSetting("s3Enabled", e.target.value)}
                >
                  <option value="0">Disabled</option>
                  <option value="1">Enabled</option>
                </select>
                <label>Bucket</label>
                <input
                  key={settings.s3Bucket ?? "s3-bucket-empty"}
                  defaultValue={settings.s3Bucket ?? ""}
                  placeholder="my-aonarr-backups"
                  onBlur={(e) => saveSetting("s3Bucket", e.target.value)}
                />
                <label>Region</label>
                <input
                  key={settings.s3Region ?? "s3-region-empty"}
                  defaultValue={settings.s3Region ?? ""}
                  placeholder="us-east-1"
                  onBlur={(e) => saveSetting("s3Region", e.target.value)}
                />
                <label>Custom endpoint (blank for AWS S3; set for MinIO/B2/etc.)</label>
                <input
                  key={settings.s3Endpoint ?? "s3-endpoint-empty"}
                  defaultValue={settings.s3Endpoint ?? ""}
                  placeholder="https://s3.us-west-000.backblazeb2.com"
                  onBlur={(e) => saveSetting("s3Endpoint", e.target.value)}
                />
                <label>Access key ID</label>
                <input
                  key={settings.s3AccessKeyId ?? "s3-access-key-empty"}
                  defaultValue={settings.s3AccessKeyId ?? ""}
                  onBlur={(e) => saveSetting("s3AccessKeyId", e.target.value)}
                />
                <label>Secret access key</label>
                <input
                  type="password"
                  key={settings.s3SecretAccessKey ?? "s3-secret-key-empty"}
                  defaultValue={settings.s3SecretAccessKey ?? ""}
                  onBlur={(e) => saveSetting("s3SecretAccessKey", e.target.value)}
                />
                <label>Key prefix (optional folder path within the bucket)</label>
                <input
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
                    <th>Path</th>
                    <th>Size</th>
                  </tr>
                </thead>
                <tbody>
                  {orphaned.map((o) => (
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
                    <th>Title</th>
                    <th>New path</th>
                  </tr>
                </thead>
                <tbody>
                  {renameResult.renamed.map((r, i) => (
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
                    <th>Title</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {renameResult.errors.map((e, i) => (
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
                <button className="danger" onClick={deleteAllUnmonitoredNoFile} style={{ marginBottom: 8 }}>
                  Delete all {unmonitoredNoFile.length}
                </button>
                <table>
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Type</th>
                      <th>Added</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {unmonitoredNoFile.map((i) => (
                      <tr key={i.id}>
                        <td>
                          {i.title}
                          {i.year ? ` (${i.year})` : ""}
                        </td>
                        <td>{i.type}</td>
                        <td>{i.addedAt}</td>
                        <td>
                          <button className="danger" onClick={() => deleteUnmonitoredNoFile(i.id)}>
                            Delete
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
                <th>Release group</th>
                <th>Successes</th>
                <th>Failures</th>
                <th>Success rate</th>
              </tr>
            </thead>
            <tbody>
              {groupStats.map((g) => (
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
                  <th>Item</th>
                  <th>Path</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {libraryMismatches.map((m, idx) => (
                  <tr key={idx}>
                    <td>{m.label}</td>
                    <td>{m.path}</td>
                    <td>
                      <button className="secondary" onClick={() => navigate(`/media/${m.mediaItemId}`)}>
                        Open
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
              <th>Root folder</th>
              <th>Type</th>
              <th>Free</th>
              <th>Total</th>
              <th>Est. days until full</th>
            </tr>
          </thead>
          <tbody>
            {status.diskSpace.map((d, idx) => (
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
          <button className="secondary" onClick={loadLogs} disabled={logsLoading}>
            {logsLoading ? "Loading..." : logs ? "Refresh" : "Load logs"}
          </button>
          {logs && (
            <button className="secondary" onClick={downloadLogs}>
              Download .log
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
      </div>
    </div>
  );
}
