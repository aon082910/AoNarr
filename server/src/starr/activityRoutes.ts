import { db } from "../db/index.js";
import { HttpError } from "../middleware/errorHandler.js";
import { findUpgradeCandidates } from "../services/upgradeCandidates.js";
import { EPISODE_TITLE_HOLD_PREFIX } from "../services/episodeTitleRule.js";
import { callNative } from "./native.js";
import { type StarrApp, typeFilter } from "./apps.js";
import {
  episodeResource,
  loadContext,
  subItemResource,
  titleResources,
  titleRows,
  type LibraryContext,
} from "./libraryResources.js";
import {
  dayOrNull,
  flag,
  idList,
  isoOrNull,
  numericId,
  pagedBody,
  pagingOf,
  qualityModelOf,
  type PagingRequest,
} from "./shapes.js";
import type { StarrRoutes } from "./router.js";

/** Queue, history, calendar and wanted: what a dashboard or an automation watches. */

const pascal = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

// --- queue -----------------------------------------------------------------------------------------------------------

function formatTimeLeft(seconds: number | null): string | undefined {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return undefined;
  const s = Math.round(seconds);
  const days = Math.floor(s / 86400);
  const clock = [Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
  return days > 0 ? `${days}.${clock}` : clock;
}

/** Starr's three words for a download in its queue, from what AoNarr knows of the row and the client's last answer. */
function trackedStateOf(row: any): { status: string; state: string; trackedStatus: "ok" | "warning" | "error"; message: string | null } {
  const note = row.status_message ? String(row.status_message) : null;
  const clientState = String(row.client_state ?? "");
  switch (row.status) {
    case "completed":
      if (row.import_started_at) return { status: "completed", state: "importing", trackedStatus: "ok", message: null };
      // Waiting for an episode's title is Starr's "import pending" with a note; every other reason needs someone to look.
      if (row.import_skipped_reason && String(row.import_skipped_reason).startsWith(EPISODE_TITLE_HOLD_PREFIX)) {
        return { status: "completed", state: "importPending", trackedStatus: "warning", message: String(row.import_skipped_reason) };
      }
      if (row.import_skipped_reason) return { status: "completed", state: "importBlocked", trackedStatus: "warning", message: String(row.import_skipped_reason) };
      return { status: "completed", state: "importPending", trackedStatus: "ok", message: null };
    case "failed":
      return { status: "failed", state: "failed", trackedStatus: "error", message: note ?? "The download failed" };
    case "queued":
      return { status: "queued", state: "downloading", trackedStatus: note ? "warning" : "ok", message: note };
    default:
      if (clientState === "paused") return { status: "paused", state: "downloading", trackedStatus: "ok", message: note };
      if (clientState === "warning" || clientState === "stalled") return { status: clientState === "warning" ? "warning" : "downloading", state: "downloading", trackedStatus: "warning", message: note };
      return { status: "downloading", state: "downloading", trackedStatus: note ? "warning" : "ok", message: note };
  }
}

function queueResource(ctx: LibraryContext, row: any, embeds: { parent?: any; child?: any }) {
  const app = ctx.app;
  const size = row.size == null ? 0 : Number(row.size);
  const progress = Number(row.progress ?? 0);
  const sizeleft = row.size_left != null ? Number(row.size_left) : Math.max(0, Math.round(size * (1 - Math.min(1, Math.max(0, progress)))));
  const eta = row.eta_seconds == null ? null : Number(row.eta_seconds);
  const tracked = trackedStateOf(row);
  const protocol = row.protocol === "usenet" || row.protocol === "torrent" ? row.protocol : row.client_type === "sabnzbd" || row.client_type === "nzbget" ? "usenet" : "torrent";
  return {
    id: Number(row.id),
    [app.parentKey]: Number(row.media_item_id),
    ...(app.childKey && row.child_id != null ? { [app.childKey]: Number(row.child_id) } : {}),
    ...(app.key === "sonarr" && row.season_number != null ? { seasonNumber: Number(row.season_number) } : {}),
    ...(embeds.parent ? { [app.parent]: embeds.parent } : {}),
    ...(embeds.child && app.child ? { [app.child]: embeds.child } : {}),
    languages: [{ id: 1, name: "English" }],
    quality: qualityModelOf(ctx.catalog, row.quality),
    customFormats: [],
    customFormatScore: 0,
    size,
    title: row.title,
    estimatedCompletionTime: eta != null && tracked.status === "downloading" ? new Date(Date.now() + eta * 1000).toISOString() : undefined,
    added: isoOrNull(row.added_at) ?? undefined,
    status: tracked.status,
    trackedDownloadStatus: tracked.trackedStatus,
    trackedDownloadState: tracked.state,
    statusMessages: tracked.message ? [{ title: row.title, messages: [tracked.message] }] : [],
    errorMessage: tracked.trackedStatus === "error" ? tracked.message ?? undefined : undefined,
    downloadId: row.download_id ?? undefined,
    protocol,
    downloadClient: row.client_name ?? undefined,
    downloadClientHasPostImportCategory: false,
    indexer: row.indexer_name ?? undefined,
    outputPath: row.download_path ?? undefined,
    ...(app.key === "sonarr" ? { episodeHasFile: false } : {}),
    sizeleft,
    timeleft: tracked.status === "downloading" ? formatTimeLeft(eta) : undefined,
  };
}

async function queueRows(app: StarrApp, extraWhere = "", extraParams: unknown[] = [], order = "q.id DESC", paging?: { limit: number; offset: number }) {
  const f = typeFilter(app);
  const childColumn = app.child === "episode" ? "q.episode_id" : app.child ? "q.sub_item_id" : "NULL";
  const rows = (await db
    .prepare(
      `SELECT q.*, ${childColumn} AS child_id, i.name AS indexer_name, c.name AS client_name, c.type AS client_type
       FROM queue q
       JOIN media_items m ON m.id = q.media_item_id
       LEFT JOIN indexers i ON i.id = q.indexer_id
       LEFT JOIN download_clients c ON c.id = q.download_client_id
       WHERE ${f.sql}${extraWhere}
       ORDER BY ${order}${paging ? " LIMIT ? OFFSET ?" : ""}`
    )
    .all(...f.params, ...extraParams, ...(paging ? [paging.limit, paging.offset] : []))) as any[];
  return rows;
}

async function childRows(app: StarrApp, ids: number[]): Promise<Map<number, any>> {
  if (!app.child || ids.length === 0) return new Map();
  const table = app.child === "episode" ? "episodes" : "sub_items";
  const rows = (await db.prepare(`SELECT * FROM ${table} WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids)) as any[];
  return new Map(rows.map((r) => [Number(r.id), r]));
}

/** The title resource of each referenced item, and the part resource of each referenced part, for the include* flags. */
async function embedsFor(ctx: LibraryContext, rows: any[], includeParent: boolean, includeChild: boolean) {
  const app = ctx.app;
  const parents = new Map<number, any>();
  const children = new Map<number, any>();
  if (includeParent || includeChild) {
    const titles = await titleRows(app, [...new Set(rows.map((r) => Number(r.media_item_id)))]);
    const resources = await titleResources(ctx, titles);
    resources.forEach((resource) => parents.set(Number(resource.id), resource));
    if (includeChild && app.child) {
      const parts = await childRows(app, [...new Set(rows.map((r) => Number(r.child_id ?? r.episode_id ?? r.sub_item_id)).filter((n) => Number.isFinite(n) && n > 0))]);
      for (const [id, part] of parts) {
        children.set(id, app.child === "episode" ? episodeResource(ctx, part) : subItemResource(ctx, app, part));
      }
    }
  }
  return { parents, children };
}

// --- history ---------------------------------------------------------------------------------------------------------

/** AoNarr's history events as this app's event names, and the numbers a Starr client filters history with. */
function eventNamesOf(app: StarrApp): Record<string, { name: string; code: number }> {
  const file = app.key === "sonarr" ? "episodeFile" : app.key === "radarr" ? "movieFile" : app.key === "lidarr" ? "trackFile" : "bookFile";
  // The numbers are each app's own enum (Radarr's skips two: movieFolderImported is 7).
  const codes = app.key === "radarr" ? { deleted: 6, renamed: 8, removed: 9 } : app.key === "sonarr" ? { deleted: 5, renamed: 6, removed: 7 } : { deleted: 5, renamed: 6, removed: 10 };
  return {
    grabbed: { name: "grabbed", code: 1 },
    imported: { name: app.key === "sonarr" || app.key === "radarr" ? "downloadFolderImported" : `${file}Imported`, code: 3 },
    failed: { name: "downloadFailed", code: 4 },
    deleted: { name: `${file}Deleted`, code: codes.deleted },
    renamed: { name: `${file}Renamed`, code: codes.renamed },
    removed: { name: "downloadIgnored", code: codes.removed },
  };
}

function parseData(raw: unknown): Record<string, any> {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
  } catch {
    return {};
  }
}

function historyResource(ctx: LibraryContext, row: any, embeds: { parent?: any; child?: any }) {
  const app = ctx.app;
  const data = parseData(row.data);
  const names = eventNamesOf(app);
  const named = names[row.event_type];
  const release = typeof data.releaseTitle === "string" ? data.releaseTitle : typeof data.title === "string" ? data.title : typeof data.label === "string" ? data.label : row.media_title;
  const childId = app.child === "episode" ? row.episode_id : app.child ? row.sub_item_id : null;
  return {
    id: Number(row.id),
    [app.parentKey]: Number(row.media_item_id),
    ...(app.childKey && childId != null ? { [app.childKey]: Number(childId) } : {}),
    ...(embeds.parent ? { [app.parent]: embeds.parent } : {}),
    ...(embeds.child && app.child ? { [app.child]: embeds.child } : {}),
    sourceTitle: release,
    languages: [{ id: 1, name: "English" }],
    quality: qualityModelOf(ctx.catalog, typeof data.quality === "string" ? data.quality : null),
    customFormats: [],
    customFormatScore: 0,
    qualityCutoffNotMet: false,
    date: isoOrNull(row.created_at),
    downloadId: typeof data.downloadId === "string" ? data.downloadId : undefined,
    eventType: named?.name ?? row.event_type,
    // The facts of the release a dashboard shows. Its download link and indexer key never leave AoNarr here.
    data: {
      indexer: data.indexerName ?? data.indexer ?? undefined,
      downloadClientName: data.client?.name ?? data.clientName ?? undefined,
      size: data.size != null ? String(data.size) : undefined,
      releaseGroup: data.releaseGroup ?? undefined,
      protocol: data.protocol ?? undefined,
      droppedPath: data.from ?? undefined,
      importedPath: data.to ?? data.path ?? undefined,
    },
  };
}

function eventFilter(app: StarrApp, raw: unknown): string[] | null {
  if (raw === undefined || raw === "") return null;
  const names = eventNamesOf(app);
  const wanted = String(raw).toLowerCase();
  const hit = Object.entries(names).filter(([, e]) => String(e.code) === wanted || e.name.toLowerCase() === wanted).map(([aonarr]) => aonarr);
  return hit.length > 0 ? hit : [];
}

async function historyRows(app: StarrApp, where: string[], params: unknown[], order: string, paging?: { limit: number; offset: number }) {
  const f = typeFilter(app);
  const known = Object.keys(eventNamesOf(app));
  return (await db
    .prepare(
      `SELECT h.*, m.title AS media_title FROM history h JOIN media_items m ON m.id = h.media_item_id
       WHERE ${f.sql} AND h.event_type IN (${known.map(() => "?").join(",")})${where.length > 0 ? ` AND ${where.join(" AND ")}` : ""}
       ORDER BY ${order}${paging ? " LIMIT ? OFFSET ?" : ""}`
    )
    .all(...f.params, ...known, ...params, ...(paging ? [paging.limit, paging.offset] : []))) as any[];
}

async function historyCount(app: StarrApp, where: string[], params: unknown[]): Promise<number> {
  const f = typeFilter(app);
  const known = Object.keys(eventNamesOf(app));
  const row = (await db
    .prepare(`SELECT COUNT(*) AS c FROM history h JOIN media_items m ON m.id = h.media_item_id WHERE ${f.sql} AND h.event_type IN (${known.map(() => "?").join(",")})${where.length > 0 ? ` AND ${where.join(" AND ")}` : ""}`)
    .get(...f.params, ...known, ...params)) as { c: number };
  return Number(row.c);
}

// --- wanted and calendar ---------------------------------------------------------------------------------------

type Part = { kind: "episode" | "subItem" | "title"; row: any };

async function partsAndTitles(ctx: LibraryContext, parts: Part[], includeTitle: boolean) {
  const app = ctx.app;
  const titles = new Map<number, any>();
  if (includeTitle) {
    const ids = [...new Set(parts.map((p) => Number(p.kind === "title" ? p.row.id : p.row.media_item_id)))];
    const resources = await titleResources(ctx, await titleRows(app, ids));
    resources.forEach((resource) => titles.set(Number(resource.id), resource));
  }
  return parts.map((p) => {
    if (p.kind === "title") return titleResources(ctx, [p.row]).then((list) => list[0]);
    const title = titles.get(Number(p.row.media_item_id));
    return p.kind === "episode" ? episodeResource(ctx, p.row, { series: title, withFile: true }) : subItemResource(ctx, app, p.row, { artist: title });
  });
}

function sortExpr(app: StarrApp, key: string | null): string {
  const k = (key ?? "").toLowerCase();
  if (app.key === "sonarr") {
    if (k.includes("title") || k.includes("series")) return "m.sort_title";
    return "e.air_date";
  }
  if (app.key === "radarr") {
    if (k.includes("title")) return "m.sort_title";
    return "COALESCE(m.release_date, '')";
  }
  if (k.includes("title")) return "s.title";
  return "COALESCE(s.release_date, '')";
}

async function wantedPage(ctx: LibraryContext, req: any, mode: "missing" | "cutoff") {
  const app = ctx.app;
  const paging: PagingRequest = pagingOf(req, app.key === "radarr" ? "movieMetadata.sortTitle" : app.key === "sonarr" ? "airDateUtc" : "releaseDate", "descending");
  const monitored = flag(req.query.monitored, true) ? 1 : 0;
  const includeTitle = flag(req.query[`include${pascal(app.parent)}`]);
  const direction = paging.sortDirection === "ascending" ? "ASC" : "DESC";
  const f = typeFilter(app);
  const order = `${sortExpr(app, paging.sortKey)} ${direction}, ${app.key === "radarr" ? "m.id" : app.key === "sonarr" ? "e.id" : "s.id"} ${direction}`;

  let cutoffIds: Set<number> | null = null;
  if (mode === "cutoff") {
    const candidates = await findUpgradeCandidates();
    cutoffIds = new Set(candidates.map((c) => Number(app.key === "radarr" ? c.mediaItemId : app.key === "sonarr" ? c.episodeId : c.subItemId)).filter((n) => Number.isFinite(n) && n > 0));
    if (cutoffIds.size === 0) return pagedBody(paging, [], 0);
  }
  const idsClause = (column: string) => (cutoffIds ? ` AND ${column} IN (${[...cutoffIds].map(() => "?").join(",")})` : "");
  const idParams = cutoffIds ? [...cutoffIds] : [];
  const missing = (column: string) => (mode === "missing" ? ` AND ${column} = 0` : ` AND ${column} = 1`);

  let rows: any[];
  let total: number;
  if (app.key === "radarr") {
    const available = `AND (COALESCE(m.minimum_availability, 'announced') IN ('announced', 'tba') OR (m.minimum_availability = 'inCinemas' AND m.release_date IS NOT NULL AND m.release_date <= ?) OR (m.minimum_availability = 'released' AND COALESCE(NULLIF(m.digital_release_date, ''), NULLIF(m.physical_release_date, ''), m.release_date) <= ?))`;
    const where = `${f.sql} AND m.monitored = ?${missing("m.has_file")}${mode === "missing" ? ` ${available}` : ""}${idsClause("m.id")}`;
    const params = [...f.params, monitored, ...(mode === "missing" ? [ctx.today, ctx.today] : []), ...idParams];
    total = Number(((await db.prepare(`SELECT COUNT(*) AS c FROM media_items m WHERE ${where}`).get(...params)) as { c: number }).c);
    rows = (await db
      .prepare(`SELECT m.*, rf.path AS root_folder_path FROM media_items m LEFT JOIN root_folders rf ON rf.id = m.root_folder_id WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, paging.pageSize, paging.offset)) as any[];
    const resources = await titleResources(ctx, rows);
    return pagedBody(paging, resources, total);
  }
  if (app.key === "sonarr") {
    const where = `${f.sql} AND e.monitored = ? AND m.monitored = 1${missing("e.has_file")}${mode === "missing" ? " AND e.air_date IS NOT NULL AND e.air_date <= ?" : ""}${idsClause("e.id")}`;
    const params = [...f.params, monitored, ...(mode === "missing" ? [ctx.today] : []), ...idParams];
    total = Number(((await db.prepare(`SELECT COUNT(*) AS c FROM episodes e JOIN media_items m ON m.id = e.media_item_id WHERE ${where}`).get(...params)) as { c: number }).c);
    rows = (await db
      .prepare(`SELECT e.* FROM episodes e JOIN media_items m ON m.id = e.media_item_id WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, paging.pageSize, paging.offset)) as any[];
    const out = await Promise.all(await partsAndTitles(ctx, rows.map((row) => ({ kind: "episode" as const, row })), includeTitle));
    return pagedBody(paging, out, total);
  }
  const where = `${f.sql} AND s.monitored = ? AND m.monitored = 1${missing("s.has_file")}${mode === "missing" ? " AND (s.release_date IS NULL OR s.release_date <= ?)" : ""}${idsClause("s.id")}`;
  const params = [...f.params, monitored, ...(mode === "missing" ? [ctx.today] : []), ...idParams];
  total = Number(((await db.prepare(`SELECT COUNT(*) AS c FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE ${where}`).get(...params)) as { c: number }).c);
  rows = (await db
    .prepare(`SELECT s.* FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, paging.pageSize, paging.offset)) as any[];
  const out = await Promise.all(await partsAndTitles(ctx, rows.map((row) => ({ kind: "subItem" as const, row })), includeTitle));
  return pagedBody(paging, out, total);
}

async function calendar(ctx: LibraryContext, req: any) {
  const app = ctx.app;
  const day = (value: unknown, fallback: string) => dayOrNull(value) ?? fallback;
  const start = day(req.query.start, ctx.today);
  const end = day(req.query.end, new Date(Date.parse(`${start}T00:00:00Z`) + 2 * 86400000).toISOString().slice(0, 10));
  const unmonitored = flag(req.query.unmonitored, false);
  const f = typeFilter(app);
  const monitoredClause = (column: string) => (unmonitored ? "" : ` AND ${column} = 1`);
  if (app.key === "radarr") {
    const rows = (await db
      .prepare(
        `SELECT m.*, rf.path AS root_folder_path FROM media_items m LEFT JOIN root_folders rf ON rf.id = m.root_folder_id
         WHERE ${f.sql}${monitoredClause("m.monitored")}
           AND ((m.release_date BETWEEN ? AND ?) OR (m.digital_release_date BETWEEN ? AND ?) OR (m.physical_release_date BETWEEN ? AND ?))
         ORDER BY m.release_date, m.id`
      )
      .all(...f.params, start, end, start, end, start, end)) as any[];
    return titleResources(ctx, rows);
  }
  if (app.key === "sonarr") {
    const rows = (await db
      .prepare(`SELECT e.* FROM episodes e JOIN media_items m ON m.id = e.media_item_id WHERE ${f.sql}${monitoredClause("e.monitored")} AND e.air_date BETWEEN ? AND ? ORDER BY e.air_date, e.id`)
      .all(...f.params, start, end)) as any[];
    return Promise.all(await partsAndTitles(ctx, rows.map((row) => ({ kind: "episode" as const, row })), flag(req.query.includeSeries)));
  }
  const rows = (await db
    .prepare(`SELECT s.* FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE ${f.sql}${monitoredClause("s.monitored")} AND s.release_date BETWEEN ? AND ? ORDER BY s.release_date, s.id`)
    .all(...f.params, start, end)) as any[];
  return Promise.all(await partsAndTitles(ctx, rows.map((row) => ({ kind: "subItem" as const, row })), flag(req.query[`include${pascal(app.parent)}`])));
}

export function registerActivityRoutes(r: StarrRoutes): void {
  const app = r.app;
  const includeParentKey = `include${pascal(app.parent)}`;
  const includeChildKey = app.child ? `include${pascal(app.child)}` : "";

  r.get("/queue", "The download queue", async (req) => {
    const ctx = await loadContext(app);
    const paging = pagingOf(req, "timeleft", "ascending");
    const sorts: Record<string, string> = {
      timeleft: "COALESCE(q.eta_seconds, 9999999999)",
      added: "q.added_at",
      title: "q.title",
      size: "q.size",
      progress: "q.progress",
      status: "q.status",
    };
    const key = (paging.sortKey ?? "").toLowerCase().split(".").pop() ?? "";
    const column = sorts[key] ?? "q.id";
    const direction = paging.sortDirection === "ascending" ? "ASC" : "DESC";
    const f = typeFilter(app);
    const total = Number(((await db.prepare(`SELECT COUNT(*) AS c FROM queue q JOIN media_items m ON m.id = q.media_item_id WHERE ${f.sql}`).get(...f.params)) as { c: number }).c);
    const rows = await queueRows(app, "", [], `${column} ${direction}, q.id DESC`, { limit: paging.pageSize, offset: paging.offset });
    const { parents, children } = await embedsFor(ctx, rows, flag(req.query[includeParentKey]), flag(req.query[includeChildKey]));
    const records = rows.map((row) =>
      queueResource(ctx, row, { parent: parents.get(Number(row.media_item_id)), child: row.child_id != null ? children.get(Number(row.child_id)) : undefined })
    );
    return pagedBody(paging, records, total);
  });

  r.get("/queue/status", "Counts of the download queue", async () => {
    const rows = await queueRows(app);
    const states = rows.map(trackedStateOf);
    return {
      totalCount: rows.length,
      count: rows.length,
      unknownCount: 0,
      errors: states.some((s) => s.trackedStatus === "error"),
      warnings: states.some((s) => s.trackedStatus === "warning"),
      unknownErrors: false,
      unknownWarnings: false,
    };
  });

  r.get("/queue/details", "The download queue without paging", async (req) => {
    const ctx = await loadContext(app);
    const parentIds = [...idList(req.query[app.parentKey]), ...idList(req.query[`${app.parent}Ids`])];
    const where = parentIds.length > 0 ? ` AND q.media_item_id IN (${parentIds.map(() => "?").join(",")})` : "";
    const rows = await queueRows(app, where, parentIds);
    const { parents, children } = await embedsFor(ctx, rows, flag(req.query[includeParentKey]), flag(req.query[includeChildKey]));
    return rows.map((row) => queueResource(ctx, row, { parent: parents.get(Number(row.media_item_id)), child: row.child_id != null ? children.get(Number(row.child_id)) : undefined }));
  });

  const removeFromQueue = async (req: any, id: number) => {
    const removeFromClient = flag(req.query.removeFromClient, true);
    const blocklist = flag(req.query.blocklist, false);
    const skipRedownload = flag(req.query.skipRedownload, false);
    const query = `blocklist=${blocklist ? 1 : 0}&removeFromClient=${removeFromClient ? 1 : 0}${skipRedownload ? "&skipRedownload=1" : ""}`;
    await callNative(req.app, "DELETE", `/api/activity/queue/${id}?${query}`);
  };
  r.delete("/queue/bulk", "Remove several downloads from the queue", async (req) => {
    const ids = idList(req.body?.ids);
    if (ids.length === 0) throw new HttpError(400, "ids is required");
    const f = typeFilter(app);
    const owned = (await db
      .prepare(`SELECT q.id FROM queue q JOIN media_items m ON m.id = q.media_item_id WHERE ${f.sql} AND q.id IN (${ids.map(() => "?").join(",")})`)
      .all(...f.params, ...ids)) as { id: number }[];
    // All or nothing: one id that is another app's, or gone, stops the whole call before anything is removed.
    if (owned.length !== new Set(ids).size) throw new HttpError(404, "NotFound");
    for (const id of new Set(ids)) await removeFromQueue(req, id);
    return {};
  });
  r.delete("/queue/:id", "Remove a download from the queue", async (req) => {
    const id = numericId(req.params.id);
    const f = typeFilter(app);
    const found = await db.prepare(`SELECT q.id FROM queue q JOIN media_items m ON m.id = q.media_item_id WHERE q.id = ? AND ${f.sql}`).get(id, ...f.params);
    if (!found) throw new HttpError(404, "NotFound");
    await removeFromQueue(req, id);
    return {};
  });

  r.get("/history", "History of grabs, imports, failures and file changes", async (req) => {
    const ctx = await loadContext(app);
    const paging = pagingOf(req, "date", "descending");
    const where: string[] = [];
    const params: unknown[] = [];
    const types = eventFilter(app, req.query.eventType);
    if (types) {
      where.push(`h.event_type IN (${types.length > 0 ? types.map(() => "?").join(",") : "NULL"})`);
      params.push(...types);
    }
    // A Starr client sends the plural (movieIds, seriesIds) or the singular (episodeId); both are read.
    const parentIds = [...idList(req.query[app.parentKey]), ...idList(req.query[`${app.parent}Ids`])];
    if (parentIds.length > 0) {
      where.push(`h.media_item_id IN (${parentIds.map(() => "?").join(",")})`);
      params.push(...parentIds);
    }
    const childIds = app.childKey && app.child ? [...idList(req.query[app.childKey]), ...idList(req.query[`${app.child}Ids`])] : [];
    if (childIds.length > 0) {
      where.push(`h.${app.child === "episode" ? "episode_id" : "sub_item_id"} IN (${childIds.map(() => "?").join(",")})`);
      params.push(...childIds);
    }
    if (typeof req.query.downloadId === "string" && req.query.downloadId) {
      // % and _ in the id are characters of the id, not wildcards.
      where.push("h.data LIKE ? ESCAPE '\\'");
      params.push(`%"downloadId":${JSON.stringify(req.query.downloadId).replace(/[\\%_]/g, "\\$&")}%`);
    }
    const total = await historyCount(app, where, params);
    const direction = paging.sortDirection === "ascending" ? "ASC" : "DESC";
    const rows = await historyRows(app, where, params, `h.created_at ${direction}, h.id ${direction}`, { limit: paging.pageSize, offset: paging.offset });
    const parents = flag(req.query[includeParentKey]) || flag(req.query[includeChildKey]);
    const embeds = await embedsFor(ctx, rows.map((x) => ({ media_item_id: x.media_item_id, child_id: app.child === "episode" ? x.episode_id : x.sub_item_id })), parents, flag(req.query[includeChildKey]));
    return pagedBody(
      paging,
      rows.map((row) => historyResource(ctx, row, { parent: embeds.parents.get(Number(row.media_item_id)), child: embeds.children.get(Number(app.child === "episode" ? row.episode_id : row.sub_item_id)) })),
      total
    );
  });

  r.get("/history/since", "History since a date", async (req) => {
    const ctx = await loadContext(app);
    const since = isoOrNull(req.query.date);
    if (!since) throw new HttpError(400, "date is required");
    const where = ["h.created_at >= ?"];
    const params: unknown[] = [since.replace("T", " ").slice(0, 19)];
    const types = eventFilter(app, req.query.eventType);
    if (types) {
      where.push(`h.event_type IN (${types.length > 0 ? types.map(() => "?").join(",") : "NULL"})`);
      params.push(...types);
    }
    const rows = await historyRows(app, where, params, "h.created_at DESC, h.id DESC");
    return rows.map((row) => historyResource(ctx, row, {}));
  });

  r.get(`/history/${app.parent}`, `History of one ${app.parent}`, async (req) => {
    const ctx = await loadContext(app);
    const id = numericId(String(req.query[app.parentKey] ?? ""), app.parentKey);
    const where = ["h.media_item_id = ?"];
    const params: unknown[] = [id];
    if (app.key === "sonarr" && req.query.seasonNumber !== undefined) {
      where.push("h.season_number = ?");
      params.push(Number(req.query.seasonNumber));
    }
    const types = eventFilter(app, req.query.eventType);
    if (types) {
      where.push(`h.event_type IN (${types.length > 0 ? types.map(() => "?").join(",") : "NULL"})`);
      params.push(...types);
    }
    const rows = await historyRows(app, where, params, "h.created_at DESC, h.id DESC");
    return rows.map((row) => historyResource(ctx, row, {}));
  });

  r.get("/calendar", "Releases and air dates in a range", async (req) => calendar(await loadContext(app), req));

  r.get("/wanted/missing", "Monitored titles that have no file", async (req) => wantedPage(await loadContext(app), req, "missing"));
  r.get("/wanted/cutoff", "Files below their profile's cutoff", async (req) => wantedPage(await loadContext(app), req, "cutoff"));
}
