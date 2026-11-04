import { db } from "../db/index.js";
import { nowOffsetHoursExpr } from "../db/asyncDb.js";
import { downloadClientFromRow, indexerFromRow } from "../db/mappers.js";
import { attachIndexerHealth } from "./indexerHealth.js";
import { checkIndexerHealth } from "./indexerClient.js";
import { getDownloadClientAdapter } from "./downloadClient.js";
import { findRepeatedImports } from "./duplicates.js";
import { findUpgradeCandidates } from "./upgradeCandidates.js";
import { getBackupProblem } from "./scheduledBackup.js";
import { getFailingJobs } from "./jobRegistry.js";
import { UNCAUGHT_WARN_PER_HOUR, uncaughtErrorStats } from "./uncaughtErrors.js";
import { onHealthChange } from "./healthEvents.js";
import { readRolledBackNotice } from "../restoreGuard.js";
import { config } from "../config.js";
import { ENCRYPTION_KEY_PATH } from "./encryption.js";
import net from "node:net";
import { getSetting } from "./settingsStore.js";
import { proxyUrlProblem, redactProxyUrl } from "./networkAddress.js";
import { failingNotificationProviders } from "./notifications.js";
import { findRootFolderProblems } from "./rootFolderCheck.js";
import { recycleBinFolderProblem } from "./recycleBin.js";
import { pathExistsAsync, StorageTimeoutError } from "./fsAsync.js";
import { log } from "./logger.js";
import { parseQualityGroups } from "./qualityGroups.js";

export const STUCK_QUEUE_HOURS = 6;
export const DISK_WARN_PERCENT_FREE = 10;

/**
 * One thing that is wrong, in the words the health notification and the Health page both use. `transient`
 * marks the kind that often clears itself after a reboot (a download client or share that starts after
 * AoNarr, an indexer still waiting for the network): those are held back from notifications during the
 * startup grace period, which Sonarr does not need to do only because it reads stored status instead of
 * calling out.
 */
export interface HealthIssue {
  source: string;
  severity: "error" | "warning";
  message: string;
  transient: boolean;
}

/** How long after the process starts that transient issues are not notified. 0 turns the grace off. */
let startupGraceMs = Number(process.env.AONARR_HEALTH_STARTUP_GRACE_MS ?? 15 * 60 * 1000);
const PROCESS_STARTED_AT = Date.now();

export function inHealthStartupGrace(): boolean {
  return Date.now() - PROCESS_STARTED_AT < startupGraceMs;
}

/** Test-only: the grace period in milliseconds. */
export function __setHealthStartupGraceMsForTests(ms: number): void {
  startupGraceMs = ms;
}

export interface HealthReport {
  checkedAt: string;
  configWarnings: { key: string; message: string }[];
  indexers: { id: number; name: string; ok: boolean; error?: string; recent: unknown }[];
  downloadClients: { id: number; name: string; ok: boolean; error?: string }[];
  stuckQueue: unknown[];
  stuckQueueThresholdHours: number;
  pendingRequests: number;
  repeatedImports: unknown[];
  upgradeCandidates: unknown[];
  diskWarnings: {
    rootFolderId: number;
    path: string;
    percentFree: number;
    freeGb: number;
    minFreeSpaceGb: number | null;
  }[];
  diskWarnPercentFree: number;
  /** Everything wrong right now, one entry per problem (the notification and the Health page read these). */
  issues: HealthIssue[];
}

/** Rejects if `promise` has not settled in `ms`. The work behind it may carry on, but the caller is released. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${Math.round(ms / 1000)}s`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** One check may take this long before the report goes on without it. */
let checkTimeoutMs = 60_000;
/** The whole report: past this a caller gets an error instead of waiting for a probe that never returns. */
let buildTimeoutMs = 3 * 60 * 1000;

/** Test-only: shorter limits, to prove a stuck check or build is given up on. */
export function __setHealthTimeoutsForTests(limits: { check?: number; build?: number }): void {
  if (limits.check !== undefined) checkTimeoutMs = limits.check;
  if (limits.build !== undefined) buildTimeoutMs = limits.build;
}

/** Runs one check; a check that throws or hangs is logged and left out instead of taking the whole report down. */
async function safely(source: string, check: () => Promise<HealthIssue[]>): Promise<HealthIssue[]> {
  try {
    return await withTimeout(check(), checkTimeoutMs, `the "${source}" check`);
  } catch (err) {
    log.warn(`[health] the "${source}" check failed:`, (err as Error).message);
    return [];
  }
}

/** Indexers that stopped being searched after repeated failures, from the persisted failure state. */
async function indexerBackoffIssues(): Promise<HealthIssue[]> {
  const rows = (await db
    .prepare(
      `SELECT i.id, i.name, s.consecutive_failures, s.backoff_until, s.backoff_reason
       FROM indexer_status s JOIN indexers i ON i.id = s.indexer_id
       WHERE i.enabled = 1 AND s.backoff_until IS NOT NULL`
    )
    .all()) as { id: number; name: string; consecutive_failures: number; backoff_until: string; backoff_reason: string | null }[];
  const issues: HealthIssue[] = [];
  for (const row of rows) {
    const until = Date.parse(row.backoff_until);
    if (!Number.isFinite(until) || until <= Date.now()) continue;
    const when = new Date(until).toISOString().slice(0, 16).replace("T", " ");
    issues.push({
      source: `indexer-backoff:${row.id}`,
      severity: "warning",
      message:
        row.backoff_reason === "rate-limit"
          ? `Indexer "${row.name}" asked to be left alone (rate limit) until ${when} UTC`
          : `Indexer "${row.name}" is not being searched until ${when} UTC after ${row.consecutive_failures} failed search(es) in a row`,
      transient: true,
    });
  }
  return issues;
}

/** Download clients that failed lately and are being left alone, from the persisted failure state (Sonarr's DownloadClientStatusCheck). */
async function downloadClientBackoffIssues(): Promise<HealthIssue[]> {
  const rows = (await db
    .prepare(
      `SELECT c.id, c.name, s.escalation_level, s.disabled_till, s.last_error
       FROM download_client_status s JOIN download_clients c ON c.id = s.client_id
       WHERE c.enabled = 1`
    )
    .all()) as { id: number; name: string; escalation_level: number; disabled_till: string | null; last_error: string | null }[];
  const issues: HealthIssue[] = [];
  for (const row of rows) {
    const until = row.disabled_till ? Date.parse(row.disabled_till) : NaN;
    // Only while it is being left alone: once the wait is over the next poll or grab decides, and a client with nothing to do is not asked.
    if (!Number.isFinite(until) || until <= Date.now()) continue;
    const when = new Date(until).toISOString().slice(0, 16).replace("T", " ");
    issues.push({
      source: `download-client-backoff:${row.id}`,
      severity: "warning",
      message: `Download client "${row.name}" is being left alone until ${when} UTC after failing${row.last_error ? ` (${row.last_error})` : ""}`,
      transient: true,
    });
  }
  return issues;
}

/**
 * A quality profile whose cutoff is not a quality on the ladder (a renamed or deleted tier) or not one the profile
 * allows. Its files can never reach the cutoff, so every one stays open to upgrades for as long as the profile is in
 * use: the cutoff is worth fixing in the profile.
 */
export async function qualityCutoffIssues(): Promise<HealthIssue[]> {
  const ladder = new Set(((await db.prepare("SELECT name FROM qualities").all()) as { name: string }[]).map((r) => r.name));
  if (ladder.size === 0) return [];
  const rows = (await db.prepare("SELECT id, name, cutoff, allowed_qualities, quality_groups FROM quality_profiles").all()) as {
    id: number;
    name: string;
    cutoff: string | null;
    allowed_qualities: string | null;
    quality_groups: string | null;
  }[];
  const issues: HealthIssue[] = [];
  for (const row of rows) {
    const cutoff = (row.cutoff ?? "").trim();
    if (!cutoff) continue; // no cutoff set: nothing to reach, nothing wrong
    let problem: string | null = null;
    if (!ladder.has(cutoff)) {
      problem = `its cutoff "${cutoff}" is not a quality on the ladder, so no file ever reaches it and files keep being upgraded`;
    } else {
      let asList: string[] = [];
      try {
        const parsed = JSON.parse(row.allowed_qualities ?? "[]");
        if (Array.isArray(parsed)) asList = parsed.filter((q): q is string => typeof q === "string");
      } catch {
        // an unreadable list is left to the profile editor
      }
      const groups = parseQualityGroups(row.quality_groups);
      const inAllowed = asList.includes(cutoff) || groups.some((g) => g.includes(cutoff) && g.some((q) => asList.includes(q)));
      if (asList.length > 0 && !inAllowed) problem = `its cutoff "${cutoff}" is not one of the qualities it allows, so a release at the cutoff is never taken`;
    }
    if (problem) issues.push({ source: `quality-cutoff:${row.id}`, severity: "warning", message: `Quality profile "${row.name}": ${problem}`, transient: false });
  }
  return issues;
}

/**
 * A download client scoped to tags takes only titles carrying one of them, so a monitored title whose tags match no
 * client has nowhere to download to even though a client exists for its protocol. Counted by the tag sets the monitored
 * titles carry (an untagged title is one with an empty set); nothing is asked while no enabled client is tag-scoped.
 */
export async function clientTagIssues(clients: ReturnType<typeof downloadClientFromRow>[]): Promise<HealthIssue[]> {
  if (!clients.some((c) => (c.tagIds?.length ?? 0) > 0)) return [];
  // Loaded here: the scheduler imports this module.
  const { pickClientForProtocol } = await import("./scheduler.js");
  const protocols = ["torrent", "usenet", "http", "slskd"] as const;
  const served = protocols.filter((p) => pickClientForProtocol(clients, p, { ignoreBackoff: true }) !== null);
  if (served.length === 0) return [];
  const takesNone = (tags: number[]) => served.every((p) => pickClientForProtocol(clients, p, { ignoreBackoff: true, itemTags: tags }) === null);

  let orphaned = 0;
  if (takesNone([])) {
    orphaned += Number(
      (
        (await db
          .prepare("SELECT COUNT(*) AS c FROM media_items m WHERE m.monitored = 1 AND NOT EXISTS (SELECT 1 FROM media_item_tags t WHERE t.media_item_id = m.id)")
          .get()) as { c: number | string }
      ).c
    );
  }
  const tagged = (await db
    .prepare("SELECT t.media_item_id AS item_id, t.tag_id AS tag_id FROM media_item_tags t JOIN media_items m ON m.id = t.media_item_id WHERE m.monitored = 1")
    .all()) as { item_id: number; tag_id: number }[];
  const tagSets = new Map<number, number[]>();
  for (const row of tagged) tagSets.set(Number(row.item_id), [...(tagSets.get(Number(row.item_id)) ?? []), Number(row.tag_id)]);
  const verdictBySet = new Map<string, boolean>();
  for (const tags of tagSets.values()) {
    const key = [...tags].sort((a, b) => a - b).join(",");
    if (!verdictBySet.has(key)) verdictBySet.set(key, takesNone(tags));
    if (verdictBySet.get(key)) orphaned++;
  }
  if (orphaned === 0) return [];
  return [
    {
      source: "download-client-tags",
      severity: "warning",
      message: `${orphaned} monitored title(s) have no download client that takes their tags, so nothing can be sent for them`,
      transient: false,
    },
  ];
}

/** Library types that are filled from feeds and channels, not from an indexer search. */
const NOT_INDEXER_SEARCHED = new Set(["podcast", "video"]);

/** A library type with a root folder but no enabled indexer that searches it never finds anything. */
async function indexerCoverageIssues(): Promise<HealthIssue[]> {
  const types = ((await db.prepare("SELECT DISTINCT media_type FROM root_folders").all()) as { media_type: string }[])
    .map((r) => r.media_type)
    .filter((type) => !NOT_INDEXER_SEARCHED.has(type));
  if (types.length === 0) return [];
  const indexers = (await db.prepare("SELECT media_types FROM indexers WHERE enabled = 1").all()) as { media_types: string | null }[];
  if (indexers.length === 0) return []; // the "no indexer at all" warning already says it
  // An IRC announce feed is not scoped to a media type, and a Soulseek daemon serves music.
  const ircFeeds = Number(((await db.prepare("SELECT COUNT(*) AS c FROM irc_feeds WHERE enabled = 1").get()) as { c: number }).c);
  if (ircFeeds > 0) return [];
  const soulseek = Number(((await db.prepare("SELECT COUNT(*) AS c FROM download_clients WHERE enabled = 1 AND type = 'slskd'").get()) as { c: number }).c);
  const covered = new Set(indexers.flatMap((i) => (i.media_types ?? "").split(",").map((s) => s.trim()).filter(Boolean)));
  if (soulseek > 0) covered.add("artist");
  return types
    .filter((type) => !covered.has(type))
    .map((type) => ({
      source: `no-indexer-for:${type}`,
      severity: "warning" as const,
      message: `No enabled indexer searches the "${type}" library, so nothing for it will ever be found`,
      transient: false,
    }));
}

/** Import lists whose last sync failed. */
async function importListIssues(): Promise<HealthIssue[]> {
  const rows = (await db
    // "Added N; M item(s) not added: no root folder..." is a warning the list keeps while it syncs fine: not a failure.
    .prepare("SELECT id, name, last_error FROM import_lists WHERE enabled = 1 AND last_error IS NOT NULL AND last_error != '' AND last_error NOT LIKE 'Added %'")
    .all()) as { id: number; name: string; last_error: string }[];
  return rows.map((row) => ({
    source: `import-list:${row.id}`,
    severity: "warning" as const,
    message: `Import list "${row.name}" failed its last sync: ${row.last_error}`,
    transient: true,
  }));
}

/** Sonarr's NotificationStatusCheck: a provider whose last sends all failed. */
async function notificationIssues(): Promise<HealthIssue[]> {
  return failingNotificationProviders().map((f) => ({
    source: `notification:${f.provider}`,
    severity: "warning" as const,
    message: `Notifications to ${f.provider} have failed ${f.failures} times in a row since ${f.since.slice(0, 16).replace("T", " ")} UTC (last error: ${f.lastError || "unknown"}).`,
    transient: true,
  }));
}

/** Whether a TCP connection to `host:port` opens within `timeoutMs`. */
function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Sonarr's ProxyCheck: the proxy the settings send everything through must be usable and accept connections. */
async function proxyIssues(): Promise<HealthIssue[]> {
  const raw = getSetting("socks5ProxyUrl");
  if (!raw || !raw.trim()) return [];
  const problem = proxyUrlProblem(raw);
  if (problem) {
    return [{ source: "proxy", severity: "error", message: `The outbound proxy "${redactProxyUrl(raw)}" ${problem}, so requests go out without a proxy.`, transient: false }];
  }
  const url = new URL(raw.trim());
  const port = Number(url.port) || (url.protocol.startsWith("socks") ? 1080 : url.protocol === "https:" ? 443 : 80);
  // An IPv6 literal comes with its brackets ("[::1]"), which net.connect does not take.
  if (await canConnect(url.hostname.replace(/^\[|\]$/g, ""), port, 5_000)) return [];
  return [
    {
      source: "proxy",
      severity: "warning",
      message: `The outbound proxy ${url.protocol}//${url.hostname}:${port} does not accept connections. Everything that is sent through it fails until it is back.`,
      transient: true,
    },
  ];
}

/** The process carries on after an uncaught exception (index.ts); a run of them means something is wrong in a timer or a background job. */
/** A download left paused (or waiting its turn) at the client this long is probably forgotten. */
const PAUSED_QUEUE_HOURS = 72;

/**
 * A paused download is never failed (the release did nothing wrong, and deleting a paused torrent would be rude), so
 * before this nothing ever noticed one the admin forgot: it held its title from every search for ever. Health now
 * names the ones that have not moved for three days.
 */
async function pausedQueueIssues(): Promise<HealthIssue[]> {
  // Rows of a client that is switched off or gone say nothing about a download someone forgot.
  const where = `FROM queue q JOIN download_clients d ON d.id = q.download_client_id
       WHERE q.status IN ('queued','downloading') AND q.client_state = 'paused' AND d.enabled = 1
       AND COALESCE(q.last_progress_at, q.added_at) <= ${nowOffsetHoursExpr(db, -PAUSED_QUEUE_HOURS)}`;
  const count = Number(((await db.prepare(`SELECT COUNT(*) AS c ${where}`).get()) as { c: number | string }).c);
  if (count === 0) return [];
  const rows = (await db.prepare(`SELECT q.title AS title ${where} ORDER BY q.added_at LIMIT 3`).all()) as { title: string }[];
  const named = rows.map((r) => `"${r.title}"`).join(", ");
  return [
    {
      source: "paused-downloads",
      severity: "warning",
      message: `${count} download${count === 1 ? " has" : "s have"} sat paused or waiting at the download client for more than ${PAUSED_QUEUE_HOURS / 24} days without moving (${named}${count > 3 ? ", …" : ""}). ${count === 1 ? "It holds" : "They hold"} the title from every search; resume ${count === 1 ? "it" : "them"} in the client or remove ${count === 1 ? "it" : "them"} from Activity.`,
      transient: false,
    },
  ];
}

/** A restore that failed to start twice was rolled back at start-up (restoreGuard.ts): the admin must hear of it. */
async function restoreRolledBackIssues(): Promise<HealthIssue[]> {
  if (config.databaseDriver !== "sqlite") return [];
  const notice = readRolledBackNotice({ dbPath: config.dbPath, keyPath: ENCRYPTION_KEY_PATH });
  if (!notice) return [];
  return [
    {
      source: "restore-rolled-back",
      severity: "error",
      message: `The database you restored did not start (${notice.startsTried} tries), so the previous database was put back. The restored file is kept as ${notice.failedDatabase}; the backup it came from may be damaged or from an incompatible version.`,
      transient: false,
    },
  ];
}

async function uncaughtErrorIssues(): Promise<HealthIssue[]> {
  const stats = uncaughtErrorStats();
  if (stats.lastHour <= UNCAUGHT_WARN_PER_HOUR) return [];
  return [
    {
      source: "uncaught-errors",
      severity: "warning",
      message: `${stats.lastHour} unexpected errors in the last hour that no code handled${stats.lastMessage ? ` (the last: ${stats.lastMessage})` : ""}. AoNarr kept running; the Logs page shows each one.`,
      transient: true,
    },
  ];
}

async function failingJobIssues(): Promise<HealthIssue[]> {
  return (await getFailingJobs(3)).map((job) => ({
    source: `job:${job.key}`,
    severity: "warning" as const,
    message: `Job "${job.name}" failed its last ${job.failures} runs${job.lastError ? `: ${job.lastError}` : ""}`,
    transient: false,
  }));
}

/**
 * Sonarr's RemotePathMappingCheck, in the form AoNarr can answer: a finished download whose reported
 * location AoNarr cannot see. The commonest Docker mistake is a client and AoNarr that see the same folder
 * under different paths; without a mapping the importer widens to a search of the whole downloads folder or
 * fails with "No matching file found". One issue per client, with the first path it could not see.
 */
async function downloadPathIssues(): Promise<HealthIssue[]> {
  const rows = (await db
    .prepare(
      `SELECT q.download_path AS path, d.id AS client_id, d.name AS client_name
       FROM queue q JOIN download_clients d ON d.id = q.download_client_id
       WHERE q.status = 'completed' AND q.download_path IS NOT NULL AND q.download_path != ''
       ORDER BY q.id DESC LIMIT 40`
    )
    .all()) as { path: string; client_id: number; client_name: string }[];
  const issues = new Map<number, HealthIssue>();
  for (const row of rows) {
    if (issues.has(row.client_id)) continue;
    let visible: boolean;
    try {
      visible = await pathExistsAsync(row.path, 10_000);
    } catch (err) {
      if (err instanceof StorageTimeoutError) continue; // an unresponsive mount is the root folder check's to report
      throw err;
    }
    if (!visible) {
      issues.set(row.client_id, {
        source: `download-path:${row.client_id}`,
        severity: "warning",
        message: `Download client "${row.client_name}" reports a finished download at "${row.path}", which AoNarr cannot see. Check the Remote Path Mappings (the client's folder must be mapped to a folder inside AoNarr).`,
        transient: false,
      });
    }
  }
  return [...issues.values()];
}

/** Client settings that delete or move a download before AoNarr can import it (an adapter's own `healthNotes`). */
async function downloadClientConfigIssues(clients: ReturnType<typeof downloadClientFromRow>[]): Promise<HealthIssue[]> {
  const issues: HealthIssue[] = [];
  for (const client of clients) {
    const adapter = getDownloadClientAdapter(client.type);
    if (!adapter?.healthNotes) continue;
    try {
      for (const note of await adapter.healthNotes(client)) {
        issues.push({ source: `download-client-config:${client.id}`, severity: "warning", message: `Download client "${client.name}": ${note}`, transient: false });
      }
    } catch {
      // an unreachable client is already reported by the reachability check
    }
  }
  return issues;
}

async function rootFolderIssues(): Promise<HealthIssue[]> {
  return (await findRootFolderProblems()).map((problem) => ({
    source: `root-folder:${problem.rootFolderId}`,
    severity: problem.kind === "unwritable" || problem.kind === "not_a_directory" ? ("error" as const) : ("warning" as const),
    message: problem.message,
    // A share that is not up yet after a reboot looks like missing/empty/unreachable; read-only and not-a-folder do not clear by themselves.
    transient: problem.kind === "missing" || problem.kind === "empty" || problem.kind === "unreachable",
  }));
}

async function recycleBinIssues(): Promise<HealthIssue[]> {
  const problem = await recycleBinFolderProblem();
  return problem ? [{ source: "recycle-bin", severity: "error", message: `Recycle bin: ${problem}. Deleted and replaced files cannot be kept, so nothing is deleted until this is fixed.`, transient: false }] : [];
}

let cache: { at: number; report: HealthReport } | null = null;
let inFlight: Promise<HealthReport> | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;
/** Bumped by markHealthStale: a run that started before it must not be kept as the answer afterwards. */
let generation = 0;
let inFlightGeneration = 0;

/**
 * Something the checks look at has just changed (a root folder, indexer, download client, import list or setting was
 * saved, a backup ended): the next view runs the checks again instead of showing the kept report for up to ten
 * minutes. Sonarr runs its health checks on such events as well as every six hours.
 */
export function markHealthStale(): void {
  generation++;
  cache = null;
}
onHealthChange(markHealthStale);

/** Test-only: forget the cached report. */
export function clearHealthReportCache(): void {
  cache = null;
  inFlight = null;
  generation++;
}

async function buildHealthReport(): Promise<HealthReport> {
  const indexers = ((await db.prepare("SELECT * FROM indexers WHERE enabled = 1").all()) as any[]).map(indexerFromRow);
  // Historical recent-attempt data (from indexer_health, see services/indexerHealth.ts) alongside the live
  // reachability check below — an indexer can pass a live "is it up right now" check while still having been
  // unreliable over its last 50 real search attempts, and vice versa.
  await attachIndexerHealth(indexers as any[]);
  const indexerHealth = await Promise.all(
    indexers.map(async (idx: any) => ({ id: idx.id, name: idx.name, ...(await checkIndexerHealth(idx)), recent: idx.health }))
  );

  const stuckQueueRows = (await db
    .prepare(
      `SELECT q.id, q.title, q.status, q.added_at AS "addedAt", m.title AS "mediaTitle" FROM queue q
       JOIN media_items m ON m.id = q.media_item_id
       WHERE q.status IN ('queued','downloading')
       AND q.added_at <= ${nowOffsetHoursExpr(db, -STUCK_QUEUE_HOURS)}`
    )
    .all()) as any[];

  const pendingRequests = Number(((await db.prepare("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'").get()) as { c: number }).c);
  const repeatedImports = await findRepeatedImports();
  const upgradeCandidates = await findUpgradeCandidates();

  const downloadClients = ((await db.prepare("SELECT * FROM download_clients WHERE enabled = 1").all()) as any[]).map(downloadClientFromRow);
  const downloadClientHealth = await Promise.all(
    downloadClients.map(async (client) => {
      try {
        await getDownloadClientAdapter(client.type).getStatus(client, []);
        return { id: client.id, name: client.name, ok: true };
      } catch (err) {
        return { id: client.id, name: client.name, ok: false, error: (err as Error).message };
      }
    })
  );

  const rootFolders = (await db.prepare("SELECT id, path, min_free_space_gb FROM root_folders").all()) as {
    id: number;
    path: string;
    min_free_space_gb: number | null;
  }[];
  const diskWarnings = (
    await Promise.all(
      rootFolders.map(async (folder) => {
        const latest = (await db
          .prepare("SELECT free_bytes, total_bytes FROM disk_usage_samples WHERE root_folder_id = ? ORDER BY sampled_at DESC LIMIT 1")
          .get(folder.id)) as { free_bytes: number; total_bytes: number } | undefined;
        if (!latest || !Number(latest.total_bytes)) return null;
        const percentFree = (Number(latest.free_bytes) / Number(latest.total_bytes)) * 100;
        // Radarr-style per-folder minimum free space (GB) — independent of the global percent threshold, since a
        // huge drive at 8% free might still have hundreds of GB left (not actually urgent), while a small drive
        // at 15% free might have almost none (is).
        const freeGb = Number(latest.free_bytes) / 1e9;
        const belowMinFreeSpace = folder.min_free_space_gb != null && freeGb < folder.min_free_space_gb;
        if (percentFree >= DISK_WARN_PERCENT_FREE && !belowMinFreeSpace) return null;
        return {
          rootFolderId: folder.id,
          path: folder.path,
          percentFree: Math.round(percentFree * 10) / 10,
          freeGb: Math.round(freeGb * 10) / 10,
          minFreeSpaceGb: folder.min_free_space_gb,
        };
      })
    )
  ).filter((w): w is NonNullable<typeof w> => w !== null);

  // Config-completeness warnings — distinct from the reachability/rate checks above, which all assume something is
  // already configured and only report on how well it's working. A fresh or partially set-up instance has none of
  // those to report, so without this an admin who dismissed the onboarding checklist once has no ongoing signal
  // that a whole library type still has, say, no root folder and will never actually import anything.
  const [rootFolderCount, indexerCount, downloadClientCount] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS c FROM root_folders").get() as Promise<{ c: number }>,
    db.prepare("SELECT COUNT(*) AS c FROM indexers WHERE enabled = 1").get() as Promise<{ c: number }>,
    db.prepare("SELECT COUNT(*) AS c FROM download_clients WHERE enabled = 1").get() as Promise<{ c: number }>,
  ]);
  const configWarnings: { key: string; message: string }[] = [];
  if (Number(rootFolderCount.c) === 0) configWarnings.push({ key: "no_root_folder", message: "No root folder configured — nothing has anywhere to import to yet." });
  if (Number(indexerCount.c) === 0) configWarnings.push({ key: "no_indexer", message: "No enabled indexer configured — searches will never find anything." });
  if (Number(downloadClientCount.c) === 0) {
    configWarnings.push({ key: "no_download_client", message: "No enabled download client configured — grabs have nowhere to download to." });
  }

  const issues: HealthIssue[] = [];
  for (const idx of indexerHealth) {
    if (!idx.ok) issues.push({ source: `indexer:${idx.id}`, severity: "warning", message: `Indexer "${idx.name}" is unreachable`, transient: true });
  }
  for (const client of downloadClientHealth) {
    if (!client.ok) issues.push({ source: `download-client:${client.id}`, severity: "error", message: `Download client "${client.name}" is unreachable`, transient: true });
  }
  for (const warning of diskWarnings) {
    issues.push({
      source: `disk:${warning.rootFolderId}`,
      severity: "warning",
      message:
        warning.percentFree < DISK_WARN_PERCENT_FREE
          ? `"${warning.path}" is low on disk space (${Math.round(warning.percentFree)}% free)`
          : `"${warning.path}" is below its configured minimum free space (${Math.round(warning.freeGb)}GB free, minimum ${warning.minFreeSpaceGb}GB)`,
      transient: false,
    });
  }
  const backupProblem = getBackupProblem();
  if (backupProblem) {
    configWarnings.push({ key: "backup_failed", message: backupProblem });
    issues.push({ source: "backup", severity: "warning", message: backupProblem, transient: false });
  }

  const checks = await Promise.all([
    safely("indexer-backoff", indexerBackoffIssues),
    safely("download-client-backoff", downloadClientBackoffIssues),
    safely("indexer-coverage", indexerCoverageIssues),
    safely("import-lists", importListIssues),
    safely("jobs", failingJobIssues),
    safely("uncaught-errors", uncaughtErrorIssues),
    safely("restore-rolled-back", restoreRolledBackIssues),
    safely("paused-downloads", pausedQueueIssues),
    safely("notifications", notificationIssues),
    safely("proxy", proxyIssues),
    safely("download-paths", downloadPathIssues),
    safely("download-client-config", () => downloadClientConfigIssues(downloadClients)),
    safely("download-client-tags", () => clientTagIssues(downloadClients)),
    safely("root-folders", rootFolderIssues),
    safely("recycle-bin", recycleBinIssues),
    safely("quality-cutoff", qualityCutoffIssues),
  ]);
  issues.push(...checks.flat());

  return {
    checkedAt: new Date().toISOString(),
    configWarnings,
    indexers: indexerHealth,
    downloadClients: downloadClientHealth,
    stuckQueue: stuckQueueRows,
    stuckQueueThresholdHours: STUCK_QUEUE_HOURS,
    pendingRequests,
    repeatedImports,
    upgradeCandidates,
    diskWarnings,
    diskWarnPercentFree: DISK_WARN_PERCENT_FREE,
    issues,
  };
}

/**
 * The health report, kept for ten minutes. Opening the Dashboard or the System page used to ping every enabled
 * indexer and download client and re-scan history on every call; Sonarr runs its checks on events and every 6
 * hours and serves stored results. `refresh` (the 30-minute notifier, or "?refresh=1" from the Refresh button)
 * forces a new run, and concurrent callers share one. A run that does not finish in three minutes is given up on
 * (its callers get an error) so one stuck probe cannot hold every later caller.
 */
export async function getHealthReport(options: { refresh?: boolean } = {}): Promise<HealthReport> {
  if (!options.refresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.report;
  // A saved change that arrived while a run was under way makes that run's answer a stale one: the caller waiting on it
  // gets it, a later caller does not.
  if (inFlight && inFlightGeneration !== generation) inFlight = null;
  if (!inFlight) {
    const startedAt = generation;
    inFlightGeneration = startedAt;
    const run: Promise<HealthReport> = withTimeout(buildHealthReport(), buildTimeoutMs, "the health report")
      .then((report) => {
        if (startedAt === generation) cache = { at: Date.now(), report };
        return report;
      })
      .finally(() => {
        if (inFlight === run) inFlight = null;
      });
    inFlight = run;
  }
  return inFlight;
}
