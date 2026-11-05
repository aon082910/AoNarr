import type { Application } from "express";
import { db } from "../db/index.js";
import { HttpError } from "../middleware/errorHandler.js";
import { log } from "../services/logger.js";
import { findUpgradeCandidates } from "../services/upgradeCandidates.js";
import { callNative } from "./native.js";
import { type StarrApp, typeFilter } from "./apps.js";
import { idList, numericId } from "./shapes.js";
import type { StarrRoutes } from "./router.js";

/**
 * POST /command: what Overseerr (a search after an add), Unpackerr and LunaSea ask a Starr app to do. A command runs in
 * the background through AoNarr's own routes and jobs; its record (the last 100) answers GET /command and GET /command/{id}.
 */

type CommandBody = Record<string, any>;
type Action = (app: Application, body: CommandBody) => Promise<void>;

interface CommandRecord {
  id: number;
  name: string;
  commandName: string;
  body: CommandBody;
  priority: "normal";
  status: "queued" | "started" | "completed" | "failed";
  result: "unknown" | "successful" | "unsuccessful";
  queued: string;
  started?: string;
  ended?: string;
  message?: string;
  trigger: "manual";
  stateChangeTime: string;
  sendUpdatesToClient: true;
  updateScheduledTask: true;
  app: string;
}

const MAX_COMMANDS = 100;
let nextCommandId = 1;
const commands: CommandRecord[] = [];

function resource(record: CommandRecord) {
  const { app: _app, ...rest } = record;
  return rest;
}

/** Targets of a bulk search, in chunks of 100 as the native route takes them. Not awaited by the caller. */
async function searchTargets(app: Application, targets: { mediaItemId: number; episodeId?: number; subItemId?: number }[]): Promise<void> {
  for (let i = 0; i < targets.length; i += 100) {
    await callNative(app, "POST", "/api/search/bulk", { targets: targets.slice(i, i + 100) });
  }
}

async function ownedIds(starr: StarrApp, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const f = typeFilter(starr);
  const rows = (await db.prepare(`SELECT m.id FROM media_items m WHERE ${f.sql} AND m.id IN (${ids.map(() => "?").join(",")})`).all(...f.params, ...ids)) as { id: number }[];
  return rows.map((r) => Number(r.id));
}

function actionsOf(starr: StarrApp): Record<string, Action> {
  const typeNames = starr.types;
  const missingTargets = async (only?: number): Promise<{ mediaItemId: number; episodeId?: number; subItemId?: number }[]> => {
    const f = typeFilter(starr);
    // One title's parts when the command names it (Overseerr's search after an add), else the whole library's.
    const one = only === undefined ? "" : " AND m.id = ?";
    const oneParam = only === undefined ? [] : [only];
    if (starr.key === "radarr") {
      const rows = (await db.prepare(`SELECT m.id FROM media_items m WHERE ${f.sql} AND m.monitored = 1 AND m.has_file = 0${one}`).all(...f.params, ...oneParam)) as { id: number }[];
      return rows.map((r) => ({ mediaItemId: Number(r.id) }));
    }
    if (starr.key === "sonarr") {
      const rows = (await db
        .prepare(`SELECT e.id, e.media_item_id FROM episodes e JOIN media_items m ON m.id = e.media_item_id WHERE ${f.sql} AND m.monitored = 1 AND e.monitored = 1 AND e.has_file = 0 AND e.air_date IS NOT NULL AND e.air_date <= ?${one}`)
        .all(...f.params, new Date().toISOString().slice(0, 10), ...oneParam)) as { id: number; media_item_id: number }[];
      return rows.map((r) => ({ mediaItemId: Number(r.media_item_id), episodeId: Number(r.id) }));
    }
    const rows = (await db
      .prepare(`SELECT s.id, s.media_item_id FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE ${f.sql} AND m.monitored = 1 AND s.monitored = 1 AND s.has_file = 0${one}`)
      .all(...f.params, ...oneParam)) as { id: number; media_item_id: number }[];
    return rows.map((r) => ({ mediaItemId: Number(r.media_item_id), subItemId: Number(r.id) }));
  };
  const cutoffTargets = async () => {
    const candidates = await findUpgradeCandidates();
    const owned = new Set(await ownedIds(starr, [...new Set(candidates.map((c) => Number(c.mediaItemId)))]));
    return candidates.filter((c) => owned.has(Number(c.mediaItemId))).map((c) => ({ mediaItemId: Number(c.mediaItemId), episodeId: c.episodeId, subItemId: c.subItemId }));
  };

  const rssSync: Action = async (app) => void (await callNative(app, "POST", "/api/jobs/rssSync/run"));
  const downloadedScan: Action = async (app) => void (await callNative(app, "POST", "/api/jobs/queuePoll/run"));
  // Overseerr and Jellyseerr send this before every read of the queue (their download tracker, each minute), and give up on
  // the read when it is refused. The poll is the same one the scheduler runs; one already running answers 202 and is enough.
  const refreshMonitoredDownloads: Action = async (app) => void (await callNative(app, "POST", "/api/jobs/queuePoll/run"));
  const refresh = (key: string, plural: string): Action => async (app, body) => {
    const ids = await ownedIds(starr, [...idList(body[key]), ...idList(body[plural])]);
    if (ids.length === 0 && (body[key] !== undefined || body[plural] !== undefined)) throw new HttpError(404, "NotFound");
    if (ids.length === 0) for (const type of typeNames) await callNative(app, "POST", `/api/media/refresh?type=${encodeURIComponent(type)}`);
    for (const id of ids) await callNative(app, "POST", `/api/media/${id}/refresh`);
  };
  const rescan = (key: string, plural: string): Action => async (app, body) => {
    const ids = await ownedIds(starr, [...idList(body[key]), ...idList(body[plural])]);
    if (ids.length === 0 && (body[key] !== undefined || body[plural] !== undefined)) throw new HttpError(404, "NotFound");
    if (ids.length === 0) for (const type of typeNames) await callNative(app, "POST", `/api/media/scan-import?type=${encodeURIComponent(type)}`);
    for (const id of ids) await callNative(app, "POST", `/api/media/${id}/scan-import`);
  };
  // MissingEpisodeSearch, MissingAlbumSearch and MissingBookSearch take the title they are for (seriesId, artistId, authorId):
  // Overseerr and Jellyseerr send it after an add, and the search must not widen to everything that is missing.
  const missingOf = (key: string): Action => async (app, body) => {
    let only: number | undefined;
    if (body[key] !== undefined && body[key] !== null && body[key] !== "") {
      [only] = await ownedIds(starr, [Number(body[key])]);
      if (!only) throw new HttpError(404, "NotFound");
    }
    await searchTargets(app, await missingTargets(only));
  };
  const searchTitles = (key: string, plural: string): Action => async (app, body) => {
    const ids = await ownedIds(starr, [...idList(body[key]), ...idList(body[plural])]);
    if (ids.length === 0) throw new HttpError(404, "NotFound");
    await searchTargets(app, ids.map((mediaItemId) => ({ mediaItemId })));
  };

  switch (starr.key) {
    case "sonarr":
      return {
        RssSync: rssSync,
        DownloadedEpisodesScan: downloadedScan,
        RefreshMonitoredDownloads: refreshMonitoredDownloads,
        RefreshSeries: refresh("seriesId", "seriesIds"),
        RescanSeries: rescan("seriesId", "seriesIds"),
        SeriesSearch: searchTitles("seriesId", "seriesIds"),
        SeasonSearch: async (app, body) => {
          const [id] = await ownedIds(starr, [Number(body.seriesId)]);
          if (!id) throw new HttpError(404, "NotFound");
          const rows = (await db.prepare("SELECT id FROM episodes WHERE media_item_id = ? AND season_number = ? AND monitored = 1").all(id, Number(body.seasonNumber))) as { id: number }[];
          await searchTargets(app, rows.map((r) => ({ mediaItemId: id, episodeId: Number(r.id) })));
        },
        EpisodeSearch: async (app, body) => {
          const ids = idList(body.episodeIds);
          if (ids.length === 0) throw new HttpError(400, "episodeIds is required");
          const f = typeFilter(starr);
          const rows = (await db.prepare(`SELECT e.id, e.media_item_id FROM episodes e JOIN media_items m ON m.id = e.media_item_id WHERE ${f.sql} AND e.id IN (${ids.map(() => "?").join(",")})`).all(...f.params, ...ids)) as { id: number; media_item_id: number }[];
          await searchTargets(app, rows.map((r) => ({ mediaItemId: Number(r.media_item_id), episodeId: Number(r.id) })));
        },
        MissingEpisodeSearch: missingOf("seriesId"),
        CutoffUnmetEpisodeSearch: async (app) => searchTargets(app, await cutoffTargets()),
      };
    case "radarr":
      return {
        RssSync: rssSync,
        DownloadedMoviesScan: downloadedScan,
        RefreshMonitoredDownloads: refreshMonitoredDownloads,
        RefreshMovie: refresh("movieId", "movieIds"),
        RescanMovie: rescan("movieId", "movieIds"),
        MoviesSearch: searchTitles("movieId", "movieIds"),
        MissingMoviesSearch: async (app) => searchTargets(app, await missingTargets()),
        CutoffUnmetMoviesSearch: async (app) => searchTargets(app, await cutoffTargets()),
      };
    case "lidarr":
      return {
        RssSync: rssSync,
        DownloadedAlbumsScan: downloadedScan,
        RefreshMonitoredDownloads: refreshMonitoredDownloads,
        RefreshArtist: refresh("artistId", "artistIds"),
        RescanFolders: rescan("artistId", "artistIds"),
        ArtistSearch: searchTitles("artistId", "artistIds"),
        AlbumSearch: async (app, body) => {
          const ids = idList(body.albumIds);
          if (ids.length === 0) throw new HttpError(400, "albumIds is required");
          const f = typeFilter(starr);
          const rows = (await db.prepare(`SELECT s.id, s.media_item_id FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE ${f.sql} AND s.id IN (${ids.map(() => "?").join(",")})`).all(...f.params, ...ids)) as { id: number; media_item_id: number }[];
          await searchTargets(app, rows.map((r) => ({ mediaItemId: Number(r.media_item_id), subItemId: Number(r.id) })));
        },
        MissingAlbumSearch: missingOf("artistId"),
      };
    case "readarr":
      return {
        RssSync: rssSync,
        DownloadedBooksScan: downloadedScan,
        RefreshMonitoredDownloads: refreshMonitoredDownloads,
        RefreshAuthor: refresh("authorId", "authorIds"),
        RescanFolders: rescan("authorId", "authorIds"),
        AuthorSearch: searchTitles("authorId", "authorIds"),
        BookSearch: async (app, body) => {
          const ids = idList(body.bookIds);
          if (ids.length === 0) throw new HttpError(400, "bookIds is required");
          const f = typeFilter(starr);
          const rows = (await db.prepare(`SELECT s.id, s.media_item_id FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE ${f.sql} AND s.id IN (${ids.map(() => "?").join(",")})`).all(...f.params, ...ids)) as { id: number; media_item_id: number }[];
          await searchTargets(app, rows.map((r) => ({ mediaItemId: Number(r.media_item_id), subItemId: Number(r.id) })));
        },
        MissingBookSearch: missingOf("authorId"),
      };
  }
}

export function registerCommandRoutes(r: StarrRoutes): void {
  const starr = r.app;
  const actions = actionsOf(starr);

  r.get("/command", "Recent commands", () => commands.filter((c) => c.app === starr.key).map(resource));
  r.get("/command/:id", "One command", (req) => {
    const record = commands.find((c) => c.id === numericId(req.params.id) && c.app === starr.key);
    if (!record) throw new HttpError(404, "NotFound");
    return resource(record);
  });

  r.post("/command", "Run a command (search, refresh, rescan, RSS sync, scan of finished downloads)", async (req) => {
    const body: CommandBody = req.body && typeof req.body === "object" ? req.body : {};
    const name = String(body.name ?? "");
    const action = Object.hasOwn(actions, name) ? actions[name] : undefined;
    if (!action) throw new HttpError(400, name ? `${starr.appName} does not run "${name}" here` : "name is required");
    const now = new Date().toISOString();
    const record: CommandRecord = {
      id: nextCommandId++,
      name,
      commandName: name.replace(/([a-z])([A-Z])/g, "$1 $2"),
      body: { ...body, sendUpdatesToClient: true, updateScheduledTask: true, trigger: "manual" },
      priority: "normal",
      status: "queued",
      result: "unknown",
      queued: now,
      trigger: "manual",
      stateChangeTime: now,
      sendUpdatesToClient: true,
      updateScheduledTask: true,
      app: starr.key,
    };
    commands.unshift(record);
    if (commands.length > MAX_COMMANDS) commands.length = MAX_COMMANDS;

    // A command naming a title that is not here fails the request, as Starr's does; the work itself goes on in the background.
    const finished = (ok: boolean, message?: string) => {
      record.status = ok ? "completed" : "failed";
      record.result = ok ? "successful" : "unsuccessful";
      record.ended = new Date().toISOString();
      record.stateChangeTime = record.ended;
      if (message) record.message = message;
    };
    record.status = "started";
    record.started = new Date().toISOString();
    const running = action(req.app, body);
    // Settled fast for the checks that can fail on the caller's input (an unknown id), so they answer as an error.
    let timer: NodeJS.Timeout | undefined;
    const early = await Promise.race([running.then(() => "done" as const, (err) => err as Error), new Promise<"pending">((resolve) => (timer = setTimeout(() => resolve("pending"), 250)))]);
    clearTimeout(timer);
    if (early instanceof Error) {
      finished(false, early.message);
      if (early instanceof HttpError && early.status < 500) throw early;
      log.warn(`[starr] ${starr.appName} command ${name} failed:`, early.message);
    } else if (early === "done") {
      finished(true);
    } else {
      running.then(
        () => finished(true),
        (err: Error) => {
          finished(false, err.message);
          log.warn(`[starr] ${starr.appName} command ${name} failed:`, err.message);
        }
      );
    }
    return resource(record);
  });
}
