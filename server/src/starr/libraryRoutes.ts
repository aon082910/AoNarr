import { db } from "../db/index.js";
import { HttpError } from "../middleware/errorHandler.js";
import { fetchByExternalId, fetchSeriesEpisodesFor, fetchSeriesSeasonsFor, searchMetadata, type MetadataSearchResult } from "../services/metadata.js";
import { SERIES_MONITOR_MODES } from "../services/monitorModes.js";
import { queueSearchAfterAdd } from "../services/searchOnAdd.js";
import { callNative } from "./native.js";
import { type StarrApp, typeFilter } from "./apps.js";
import {
  artistResource,
  authorResource,
  episodeFileResource,
  episodeResource,
  loadContext,
  movieFileResource,
  movieResource,
  seasonStats,
  seriesResource,
  subItemFileResource,
  subItemResource,
  subItemStats,
  titleResources,
  titleRow,
  titleRows,
  type LibraryContext,
} from "./libraryResources.js";
import { flag, idList, images, numericId, pagedBody, pagingOf, parseExternalIds, slugOf, validationFailure } from "./shapes.js";
import { childOrder, listTitles, sendChildren } from "./libraryList.js";
import type { StarrRoutes } from "./router.js";

/** Titles and their parts: list, get, look up, add, edit and delete. */

const pascal = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

export async function requireTitle(app: StarrApp, id: number): Promise<any> {
  const row = await titleRow(app, id);
  if (!row) throw new HttpError(404, "NotFound");
  return row;
}

export async function oneResource(ctx: LibraryContext, row: any): Promise<any> {
  return (await titleResources(ctx, [row]))[0];
}

/** The library item an identity names, matching on any id the two share. */
export async function findExisting(app: StarrApp, ids: Record<string, string>): Promise<any | null> {
  const wanted = Object.entries(ids).filter(([key, value]) => value && ["tvdb", "tmdb", "imdb", "musicbrainz", "openlibrary"].includes(key));
  if (wanted.length === 0) return null;
  const rows = await titleRows(app);
  return (
    rows.find((row) => {
      const have = parseExternalIds(row.external_ids);
      return wanted.some(([key, value]) => have[key] === value);
    }) ?? null
  );
}

// --- lookup ----------------------------------------------------------------------------------------------------------

const ID_TERM = /^(tvdb|tmdb|imdb):\s*(\S+)$/i;

/** "tvdb:123", "tmdb:603", "imdb:tt0133093" are looked up by id; anything else is a search. */
async function providerLookup(app: StarrApp, term: string): Promise<MetadataSearchResult[]> {
  const type = app.key === "radarr" ? "movie" : "series";
  const byId = ID_TERM.exec(term.trim());
  try {
    if (byId) return [await fetchByExternalId(type, byId[1].toLowerCase(), byId[2])];
    const results = await searchMetadata(type, term);
    return results.slice(0, 20);
  } catch {
    // A provider that does not answer, or does not know the id, finds nothing: the caller shows "not found".
    return [];
  }
}

/**
 * What a lookup answers: a title the library already holds by that id comes first, with its own id (a client such as Overseerr
 * takes a non-zero id for "already added"), and does not wait for a metadata provider that may be down.
 */
async function lookupResources(ctx: LibraryContext, term: string): Promise<any[]> {
  const byId = ID_TERM.exec(term.trim());
  if (byId) {
    const local = await findExisting(ctx.app, { [byId[1].toLowerCase()]: byId[2] });
    if (local) return [await oneResource(ctx, local)];
  }
  return Promise.all((await providerLookup(ctx.app, term)).map((result) => lookupResource(ctx, result, !!byId)));
}

/**
 * The seasons a show has. TMDB lists them; a show known only by its TVDB id (what Jellyseerr and Overseerr look up) has none
 * from there, and a request that is built on an empty list marks no season: the add then watches every one. So, for a lookup
 * by id, the seasons are read off the episode list, as Sonarr lists every season of the show.
 */
async function seasonsOf(ids: Record<string, string>, fromEpisodes: boolean): Promise<{ seasonNumber: number }[]> {
  const listed = await fetchSeriesSeasonsFor(ids).catch(() => []);
  if (listed.length > 0 || !fromEpisodes) return listed;
  const episodes = await fetchSeriesEpisodesFor(ids).catch(() => []);
  return [...new Set(episodes.map((e) => Number(e.seasonNumber)).filter((n) => Number.isInteger(n) && n >= 0))].sort((a, b) => a - b).map((seasonNumber) => ({ seasonNumber }));
}

async function lookupResource(ctx: LibraryContext, result: MetadataSearchResult, byId = false): Promise<any> {
  const app = ctx.app;
  const ids = result.externalIds ?? {};
  const existing = await findExisting(app, ids);
  if (existing) return oneResource(ctx, existing);
  const year = result.year ?? 0;
  const base = {
    id: 0,
    title: result.title,
    sortTitle: result.title.toLowerCase(),
    overview: result.overview ?? "",
    year,
    images: images(result.posterUrl, result.backdropUrl),
    cleanTitle: slugOf(result.title, "").replace(/-/g, ""),
    titleSlug: ids.tmdb && app.key === "radarr" ? ids.tmdb : slugOf(result.title, ids.tvdb ?? ids.tmdb ?? "title"),
    genres: [] as string[],
    tags: [] as number[],
    added: "0001-01-01T00:00:00Z",
    ratings: { votes: 0, value: result.rating ?? 0 },
    monitored: false,
    qualityProfileId: 0,
    path: "",
    rootFolderPath: "",
    folder: "",
    imdbId: ids.imdb ?? undefined,
    tmdbId: Number(ids.tmdb ?? 0) || 0,
    runtime: result.runtimeMinutes ?? 0,
    status: "tba",
  };
  if (app.key === "radarr") {
    return {
      ...base,
      originalTitle: result.title,
      alternateTitles: [],
      sizeOnDisk: 0,
      hasFile: false,
      studio: result.studio ?? undefined,
      inCinemas: result.releaseDate ?? undefined,
      minimumAvailability: "announced",
      isAvailable: false,
      status: "announced",
    };
  }
  const seasons = await seasonsOf(ids, byId);
  return {
    ...base,
    tvdbId: Number(ids.tvdb ?? 0) || 0,
    tvMazeId: 0,
    tvRageId: 0,
    status: /ended|cancel/i.test(result.status ?? "") ? "ended" : "continuing",
    ended: /ended|cancel/i.test(result.status ?? ""),
    seriesType: "standard",
    seasonFolder: true,
    languageProfileId: 1,
    seasons: seasons.map((s) => ({ seasonNumber: s.seasonNumber, monitored: s.seasonNumber > 0 })),
    statistics: { seasonCount: seasons.filter((s) => s.seasonNumber > 0).length, episodeFileCount: 0, episodeCount: 0, totalEpisodeCount: 0, sizeOnDisk: 0, percentOfEpisodes: 0 },
  };
}

// --- add -------------------------------------------------------------------------------------------------------------

/** The root folder an add asks for by path: it has to be one of this app's. */
export async function rootFolderByPath(app: StarrApp, folderPath: unknown): Promise<{ id: number; media_type: string } | null> {
  if (typeof folderPath !== "string" || !folderPath.trim()) return null;
  const f = typeFilter(app, "media_type");
  const rows = (await db.prepare(`SELECT id, path, media_type FROM root_folders WHERE ${f.sql}`).all(...f.params)) as { id: number; path: string; media_type: string }[];
  const wanted = folderPath.trim().replace(/[\\/]+$/, "").toLowerCase();
  const hit = rows.find((row) => String(row.path).replace(/[\\/]+$/, "").toLowerCase() === wanted);
  if (!hit) throw validationFailure([{ propertyName: "RootFolderPath", errorMessage: `Root folder "${folderPath}" is not one of ${app.appName}'s root folders` }]);
  return { id: Number(hit.id), media_type: hit.media_type };
}

async function addTitle(req: any, app: StarrApp): Promise<any> {
  const b = req.body ?? {};
  const type = app.key === "radarr" ? "movie" : "series";
  const wanted: Record<string, string> = {};
  const tvdb = Number(b.tvdbId);
  const tmdb = Number(b.tmdbId);
  if (app.key === "sonarr" && tvdb > 0) wanted.tvdb = String(tvdb);
  if (tmdb > 0) wanted.tmdb = String(tmdb);
  if (typeof b.imdbId === "string" && b.imdbId) wanted.imdb = b.imdbId;
  if (Object.keys(wanted).length === 0) {
    throw validationFailure([{ propertyName: app.key === "radarr" ? "TmdbId" : "TvdbId", errorMessage: `${app.key === "radarr" ? "TmdbId" : "TvdbId"} must be given` }]);
  }
  const duplicate = await findExisting(app, wanted);
  if (duplicate) {
    throw validationFailure([{ propertyName: app.key === "radarr" ? "TmdbId" : "TvdbId", errorMessage: `This ${app.parent} has already been added` }]);
  }

  let found: MetadataSearchResult | null = null;
  for (const [provider, id] of Object.entries(wanted)) {
    try {
      found = await fetchByExternalId(type, provider, id);
      break;
    } catch {
      // the next id this add carries
    }
  }
  if (!found) {
    throw validationFailure([{ propertyName: app.key === "radarr" ? "TmdbId" : "TvdbId", errorMessage: `No ${app.parent} was found for ${Object.entries(wanted).map(([k, v]) => `${k}:${v}`).join(", ")}` }]);
  }
  // A second look for the identity the provider returned: it may name the title by an id the request did not.
  const again = await findExisting(app, found.externalIds ?? {});
  if (again) throw validationFailure([{ propertyName: app.key === "radarr" ? "TmdbId" : "TvdbId", errorMessage: `This ${app.parent} has already been added` }]);

  const folder = await rootFolderByPath(app, b.rootFolderPath);
  await checkEdits(app, b);
  // The Monitor option, in each app's own words. Sonarr's: all, future, missing, existing, firstSeason, lastSeason, pilot,
  // recent, monitorSpecials, unmonitorSpecials, none, skip. Radarr's: movieOnly, movieAndCollection, none. One AoNarr
  // does not act on (skip, unknown, a collection) leaves the add as it is.
  const monitorOption = typeof b.addOptions?.monitor === "string" ? b.addOptions.monitor : undefined;
  let monitor: string | undefined;
  let specials: "monitor" | "unmonitor" | null = null;
  let monitored = b.monitored === false ? 0 : 1;
  if (monitorOption !== undefined) {
    if (app.key === "radarr") {
      if (monitorOption === "none") monitored = 0;
    } else if (monitorOption === "monitorSpecials") {
      specials = "monitor";
    } else if (monitorOption === "unmonitorSpecials") {
      specials = "unmonitor";
    } else {
      const mapped = monitorOption === "lastSeason" ? "latestSeason" : monitorOption;
      if ((SERIES_MONITOR_MODES as readonly string[]).includes(mapped)) monitor = mapped;
    }
  }

  // An anime root folder makes the title an anime, as picking that folder does in AoNarr's own Add screen.
  const itemType = app.key === "sonarr" && folder?.media_type === "anime" ? "anime" : type;
  const imported = await callNative(req.app, "POST", "/api/metadata/import", {
    type: itemType,
    title: found.title,
    year: found.year,
    overview: found.overview,
    posterUrl: found.posterUrl,
    backdropUrl: found.backdropUrl,
    externalIds: found.externalIds,
    releaseDate: found.releaseDate,
    rating: found.rating,
    runtimeMinutes: found.runtimeMinutes,
    studio: found.studio,
    contentRating: found.contentRating,
    ...(folder ? { rootFolderId: folder.id } : {}),
    qualityProfileId: Number(b.qualityProfileId) > 0 ? Number(b.qualityProfileId) : undefined,
    monitored,
    seriesType: app.key === "sonarr" && typeof b.seriesType === "string" ? b.seriesType : undefined,
    minimumAvailability: app.key === "radarr" && typeof b.minimumAvailability === "string" ? b.minimumAvailability : undefined,
    monitorStrategy: app.key === "sonarr" ? monitor : undefined,
    // Sonarr v4's "monitor new seasons" choice: Seerr sends it with every add, and it overrides the root folder's default.
    monitorNewItems: app.key === "sonarr" && typeof b.monitorNewItems === "string" && ["all", "none", "new"].includes(b.monitorNewItems) ? b.monitorNewItems : undefined,
    tagIds: idList(b.tags),
    confirmDuplicate: true,
  });
  const id = Number(imported.body.id);

  // The seasons the request marks, when it does not pick a Monitor option: Overseerr sends only the seasons asked for.
  if (app.key === "sonarr" && Array.isArray(b.seasons) && !monitor && !specials) {
    for (const season of b.seasons) {
      const n = Number(season?.seasonNumber);
      if (Number.isInteger(n) && n >= 0 && typeof season?.monitored === "boolean") {
        await callNative(req.app, "PATCH", `/api/media/${id}/season/${n}/monitor`, { monitored: season.monitored }).catch((err: HttpError) => {
          // A season the provider does not list has no episodes to mark.
          if (err.status !== 404) throw err;
        });
      }
    }
  }

  if (app.key === "sonarr" && specials) {
    await callNative(req.app, "PATCH", `/api/media/${id}/season/0/monitor`, { monitored: specials === "monitor" }).catch((err: HttpError) => {
      if (err.status !== 404) throw err;
    });
  }

  const wantsSearch = !!(b.addOptions?.searchForMissingEpisodes || b.addOptions?.searchForMovie || b.addOptions?.searchForMissingAlbums || b.addOptions?.searchForMissingBooks);
  // The search waits for the disk scan that follows an add and skips a title the scan found a file for, so what is already on
  // disk is not downloaded again.
  if (wantsSearch && monitored === 1) queueSearchAfterAdd(id);

  const ctx = await loadContext(app);
  return oneResource(ctx, await requireTitle(app, id));
}

// --- edit ------------------------------------------------------------------------------------------------------------

/** The checks the native routes leave to a foreign key or do not make: what an add or an edit names has to exist. */
export async function checkEdits(app: StarrApp, b: any): Promise<void> {
  const bad = (propertyName: string, errorMessage: string) => validationFailure([{ propertyName, errorMessage }]);
  if (Number(b.qualityProfileId) > 0 && !(await db.prepare("SELECT 1 AS ok FROM quality_profiles WHERE id = ?").get(Number(b.qualityProfileId)))) {
    throw bad("QualityProfileId", `Quality profile ${b.qualityProfileId} does not exist`);
  }
  if ((app.key === "lidarr" || app.key === "readarr") && Number(b.metadataProfileId) > 0 && !(await db.prepare("SELECT 1 AS ok FROM metadata_profiles WHERE id = ?").get(Number(b.metadataProfileId)))) {
    throw bad("MetadataProfileId", `Metadata profile ${b.metadataProfileId} does not exist`);
  }
  if (Array.isArray(b.tags) && b.tags.length > 0) {
    const known = new Set(((await db.prepare("SELECT id FROM tags").all()) as { id: number }[]).map((t) => Number(t.id)));
    const missing = idList(b.tags).filter((tagId) => !known.has(tagId));
    if (missing.length > 0) throw bad("Tags", `Tag ${missing[0]} does not exist`);
  }
  if (app.key === "sonarr" && b.seriesType !== undefined && !["standard", "daily", "anime"].includes(b.seriesType)) throw bad("SeriesType", `Unknown series type "${b.seriesType}"`);
  if (app.key === "radarr" && b.minimumAvailability !== undefined && !["announced", "inCinemas", "released", "tba"].includes(b.minimumAvailability)) {
    throw bad("MinimumAvailability", `Unknown minimum availability "${b.minimumAvailability}"`);
  }
}

async function editTitle(req: any, app: StarrApp, id: number): Promise<any> {
  const b = req.body ?? {};
  await requireTitle(app, id);
  await checkEdits(app, b);
  const patch: Record<string, unknown> = {};
  if (typeof b.monitored === "boolean") patch.monitored = b.monitored ? 1 : 0;
  if (Number(b.qualityProfileId) > 0) patch.qualityProfileId = Number(b.qualityProfileId);
  if (Number(b.metadataProfileId) > 0 && (app.key === "lidarr" || app.key === "readarr")) patch.metadataProfileId = Number(b.metadataProfileId);
  if (app.key === "sonarr" && typeof b.seriesType === "string") patch.seriesType = b.seriesType;
  if (app.key === "radarr" && typeof b.minimumAvailability === "string") patch.minimumAvailability = b.minimumAvailability;
  if (typeof b.monitorNewItems === "string" && ["all", "none", "new"].includes(b.monitorNewItems)) patch.monitorNewItems = b.monitorNewItems;
  const folder = await rootFolderByPath(app, b.rootFolderPath);
  if (folder) patch.rootFolderId = folder.id;
  if (Object.keys(patch).length > 0) await callNative(req.app, "PATCH", `/api/media/${id}`, patch);

  if (Array.isArray(b.tags)) {
    const wanted = new Set(idList(b.tags));
    const rows = (await db.prepare("SELECT tag_id FROM media_item_tags WHERE media_item_id = ?").all(id)) as { tag_id: number }[];
    const have = new Set(rows.map((r) => Number(r.tag_id)));
    for (const tagId of wanted) if (!have.has(tagId)) await callNative(req.app, "POST", `/api/media/${id}/tags`, { tagId });
    for (const tagId of have) if (!wanted.has(tagId)) await callNative(req.app, "DELETE", `/api/media/${id}/tags/${tagId}`);
  }
  if (app.key === "sonarr" && Array.isArray(b.seasons)) {
    const stats = (await seasonStats(app, new Date().toISOString().slice(0, 10), [id])).get(id) ?? [];
    for (const season of b.seasons) {
      const n = Number(season?.seasonNumber);
      const current = stats.find((s) => s.seasonNumber === n);
      if (!current || typeof season?.monitored !== "boolean") continue;
      if ((current.monitoredCount > 0) !== season.monitored) await callNative(req.app, "PATCH", `/api/media/${id}/season/${n}/monitor`, { monitored: season.monitored });
    }
  }
  const ctx = await loadContext(app);
  return oneResource(ctx, await requireTitle(app, id));
}

/**
 * Adds run one at a time. Two requests for the same title (a retry after a timeout, two requests for different seasons of
 * one show) would otherwise both pass the "already added" check before either had inserted, and make two series.
 */
let addQueue: Promise<unknown> = Promise.resolve();
export function oneAddAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = addQueue.then(work, work);
  addQueue = run.catch(() => undefined);
  return run;
}

// --- routes ----------------------------------------------------------------------------------------------------------

export function registerLibraryRoutes(r: StarrRoutes): void {
  const app = r.app;
  const parent = app.parent;
  const parentCapital = pascal(parent);

  // One unpaged array, as a Starr app answers it; `page` or `pageSize` asks for the paged envelope (libraryList.ts).
  r.get(`/${parent}`, `All ${parent}s (page and pageSize page it; sortKey and sortDirection sort a page)`, async (req, res) => listTitles(req, res, app));

  if (app.key === "sonarr" || app.key === "radarr") {
    // Declared before /:id, which would take "lookup" for an id.
    r.get(`/${parent}/lookup`, `Find a ${parent} by id (tvdb:, tmdb:, imdb:) or by title`, async (req) => {
      const term = String(req.query.term ?? "").trim();
      if (!term) throw new HttpError(400, "term is required");
      return lookupResources(await loadContext(app), term);
    });
  }
  if (app.key === "radarr") {
    r.get("/movie/lookup/tmdb", "Find a movie by TMDB id", async (req) => {
      const ctx = await loadContext(app);
      const id = String(req.query.tmdbId ?? "").trim();
      if (!id) throw new HttpError(400, "tmdbId is required");
      const results = await lookupResources(ctx, `tmdb:${id}`);
      if (results.length === 0) throw new HttpError(404, "NotFound");
      return results[0];
    });
    r.get("/movie/lookup/imdb", "Find a movie by IMDb id", async (req) => {
      const ctx = await loadContext(app);
      const id = String(req.query.imdbId ?? "").trim();
      if (!id) throw new HttpError(400, "imdbId is required");
      const results = await lookupResources(ctx, `imdb:${id}`);
      return results.length === 0 ? {} : results[0];
    });
  }

  r.get(`/${parent}/:id`, `One ${parent}`, async (req) => oneResource(await loadContext(app), await requireTitle(app, numericId(req.params.id))));

  if (app.key === "sonarr" || app.key === "radarr") {
    r.post(`/${parent}`, `Add a ${parent}`, async (req) => oneAddAtATime(() => addTitle(req, app)));
  }
  r.put(`/${parent}/:id`, `Edit a ${parent}`, async (req) => editTitle(req, app, numericId(req.params.id)));
  // Overseerr and others put the body with its id, to the collection.
  r.put(`/${parent}`, `Edit a ${parent} (id in the body)`, async (req) => editTitle(req, app, numericId(String(req.body?.id ?? ""), "id")));
  r.delete(`/${parent}/:id`, `Remove a ${parent}`, async (req) => {
    const id = numericId(req.params.id);
    await requireTitle(app, id);
    const query = `${flag(req.query.deleteFiles) ? "deleteFiles=1" : ""}${flag(req.query.addImportListExclusion) || flag(req.query.addImportExclusion) ? `${flag(req.query.deleteFiles) ? "&" : ""}addExclusion=1` : ""}`;
    await callNative(req.app, "DELETE", `/api/media/${id}${query ? `?${query}` : ""}`);
    return {};
  });

  // --- the parts of a title ---------------------------------------------------------------------------------------

  if (app.child === "episode") {
    r.get("/episode", "Episodes of a series", async (req) => {
      const ctx = await loadContext(app);
      const seriesId = req.query.seriesId === undefined ? null : numericId(String(req.query.seriesId), "seriesId");
      const episodeIds = idList(req.query.episodeIds);
      if (seriesId === null && episodeIds.length === 0) throw new HttpError(400, "seriesId or episodeIds must be provided");
      const f = typeFilter(app);
      const where: string[] = [f.sql];
      const params: unknown[] = [...f.params];
      if (seriesId !== null) {
        where.push("e.media_item_id = ?");
        params.push(seriesId);
      }
      if (episodeIds.length > 0) {
        where.push(`e.id IN (${episodeIds.map(() => "?").join(",")})`);
        params.push(...episodeIds);
      }
      if (req.query.seasonNumber !== undefined && req.query.seasonNumber !== "") {
        where.push("e.season_number = ?");
        params.push(Number(req.query.seasonNumber));
      }
      const rows = (await db
        .prepare(`SELECT e.* FROM episodes e JOIN media_items m ON m.id = e.media_item_id WHERE ${where.join(" AND ")} ORDER BY e.season_number, e.episode_number, e.id`)
        .all(...params)) as any[];
      let series = new Map<number, unknown>();
      if (flag(req.query.includeSeries)) {
        const resources = await titleResources(ctx, await titleRows(app, [...new Set(rows.map((x) => Number(x.media_item_id)))]));
        series = new Map(resources.map((s) => [Number(s.id), s]));
      }
      const withFile = flag(req.query.includeEpisodeFile);
      return rows.map((row) => episodeResource(ctx, row, { series: series.get(Number(row.media_item_id)), withFile }));
    });

    // Declared before /episode/:id, which would take "monitor" for an id.
    r.put("/episode/monitor", "Monitor or unmonitor episodes", async (req) => {
      const ids = idList(req.body?.episodeIds);
      const monitored = req.body?.monitored !== false;
      for (const id of ids) {
        const ep = (await db.prepare("SELECT media_item_id FROM episodes WHERE id = ?").get(id)) as { media_item_id: number } | undefined;
        if (!ep) continue;
        await callNative(req.app, "PATCH", `/api/media/${ep.media_item_id}/episodes/${id}`, { monitored: monitored ? 1 : 0 });
      }
      const ctx = await loadContext(app);
      return ids.length === 0 ? [] : ((await db.prepare(`SELECT * FROM episodes WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`).all(...ids)) as any[]).map((row) => episodeResource(ctx, row));
    });

    r.get("/episode/:id", "One episode", async (req) => {
      const ctx = await loadContext(app);
      const f = typeFilter(app);
      const row = await db.prepare(`SELECT e.* FROM episodes e JOIN media_items m ON m.id = e.media_item_id WHERE e.id = ? AND ${f.sql}`).get(numericId(req.params.id), ...f.params);
      if (!row) throw new HttpError(404, "NotFound");
      return episodeResource(ctx, row, { withFile: true });
    });
    r.put("/episode/:id", "Edit an episode (monitored)", async (req) => {
      const id = numericId(req.params.id);
      const ep = (await db.prepare("SELECT media_item_id FROM episodes WHERE id = ?").get(id)) as { media_item_id: number } | undefined;
      if (!ep) throw new HttpError(404, "NotFound");
      if (typeof req.body?.monitored === "boolean") await callNative(req.app, "PATCH", `/api/media/${ep.media_item_id}/episodes/${id}`, { monitored: req.body.monitored ? 1 : 0 });
      const ctx = await loadContext(app);
      return episodeResource(ctx, await db.prepare("SELECT * FROM episodes WHERE id = ?").get(id), { withFile: true });
    });

    r.get("/episodefile", "Episode files of a series", async (req) => {
      const ctx = await loadContext(app);
      const seriesId = req.query.seriesId === undefined ? null : numericId(String(req.query.seriesId), "seriesId");
      const fileIds = idList(req.query.episodeFileIds);
      if (seriesId === null && fileIds.length === 0) throw new HttpError(400, "seriesId or episodeFileIds must be provided");
      const f = typeFilter(app);
      const where = [f.sql, "e.has_file = 1", "e.file_path IS NOT NULL"];
      const params: unknown[] = [...f.params];
      if (seriesId !== null) {
        where.push("e.media_item_id = ?");
        params.push(seriesId);
      }
      if (fileIds.length > 0) {
        where.push(`e.id IN (${fileIds.map(() => "?").join(",")})`);
        params.push(...fileIds);
      }
      const rows = (await db
        .prepare(`SELECT e.* FROM episodes e JOIN media_items m ON m.id = e.media_item_id WHERE ${where.join(" AND ")} ORDER BY e.season_number, e.episode_number, e.id`)
        .all(...params)) as any[];
      return rows.map((row) => episodeFileResource(ctx, row));
    });
    r.get("/episodefile/:id", "One episode file", async (req) => {
      const ctx = await loadContext(app);
      const f = typeFilter(app);
      const row = await db.prepare(`SELECT e.* FROM episodes e JOIN media_items m ON m.id = e.media_item_id WHERE e.id = ? AND ${f.sql}`).get(numericId(req.params.id), ...f.params);
      const file = row ? episodeFileResource(ctx, row) : null;
      if (!file) throw new HttpError(404, "NotFound");
      return file;
    });
  }

  if (app.key === "radarr") {
    r.get("/moviefile", "Movie files", async (req) => {
      const ctx = await loadContext(app);
      const movieIds = idList(req.query.movieId);
      const fileIds = idList(req.query.movieFileIds);
      let rows = await titleRows(app, movieIds.length > 0 || fileIds.length > 0 ? [...movieIds, ...fileIds] : undefined);
      rows = rows.filter((row) => Number(row.has_file) && row.path);
      return rows.map((row) => movieFileResource(ctx, row));
    });
    r.get("/moviefile/:id", "One movie file", async (req) => {
      const ctx = await loadContext(app);
      const row = await requireTitle(app, numericId(req.params.id));
      const file = movieFileResource(ctx, row);
      if (!file) throw new HttpError(404, "NotFound");
      return file;
    });
  }

  if (app.child === "album" || app.child === "book") {
    const child = app.child;
    const childKey = app.childKey as string;
    r.get(`/${child}`, `${pascal(child)}s of an ${parent} (page and pageSize page it)`, async (req, res) => {
      const ctx = await loadContext(app);
      const paging = req.query.page !== undefined || req.query.pageSize !== undefined ? pagingOf(req, "releaseDate", "ascending") : null;
      const order = childOrder(paging);
      const parentId = req.query[app.parentKey] === undefined ? null : numericId(String(req.query[app.parentKey]), app.parentKey);
      const ids = idList(req.query[`${child}Ids`]);
      const f = typeFilter(app);
      const where = [f.sql];
      const params: unknown[] = [...f.params];
      if (parentId !== null) {
        where.push("s.media_item_id = ?");
        params.push(parentId);
      }
      if (ids.length > 0) {
        where.push(`s.id IN (${ids.map(() => "?").join(",")})`);
        params.push(...ids);
      }
      const rows = (await db.prepare(`SELECT s.* FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE ${where.join(" AND ")} ORDER BY ${order.sql}`).all(...params)) as any[];
      if (flag(req.query[`include${parentCapital}`])) {
        // The list that embeds its title is built the long way (and is not kept).
        const shown = paging ? rows.slice(paging.offset, paging.offset + paging.pageSize) : rows;
        const resources = await titleResources(ctx, await titleRows(app, [...new Set(shown.map((x) => Number(x.media_item_id)))]));
        const titles = new Map<number, unknown>(resources.map((t) => [Number(t.id), t]));
        const records = shown.map((row) => subItemResource(ctx, app, row, { artist: titles.get(Number(row.media_item_id)) }));
        return paging ? pagedBody({ ...paging, sortKey: order.key }, records, rows.length) : records;
      }
      return sendChildren(req, res, ctx, rows, paging ? { request: paging, key: order.key } : null, parentId === null && ids.length === 0);
    });
    r.put(`/${child}/monitor`, `Monitor or unmonitor ${child}s`, async (req) => {
      const ids = idList(req.body?.[`${child}Ids`]);
      const monitored = req.body?.monitored !== false;
      const f = typeFilter(app);
      const owned = ids.length === 0 ? [] : ((await db.prepare(`SELECT s.id, s.media_item_id FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE ${f.sql} AND s.id IN (${ids.map(() => "?").join(",")}) ORDER BY s.id`).all(...f.params, ...ids)) as { id: number; media_item_id: number }[]);
      for (const sub of owned) await callNative(req.app, "PATCH", `/api/media/${sub.media_item_id}/subitems/${sub.id}`, { monitored: monitored ? 1 : 0 });
      const ctx = await loadContext(app);
      return owned.length === 0 ? [] : ((await db.prepare(`SELECT * FROM sub_items WHERE id IN (${owned.map(() => "?").join(",")}) ORDER BY id`).all(...owned.map((s) => s.id))) as any[]).map((row) => subItemResource(ctx, app, row));
    });
    r.get(`/${child}/:id`, `One ${child}`, async (req) => {
      const ctx = await loadContext(app);
      const f = typeFilter(app);
      const row = await db.prepare(`SELECT s.* FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE s.id = ? AND ${f.sql}`).get(numericId(req.params.id), ...f.params);
      if (!row) throw new HttpError(404, "NotFound");
      return subItemResource(ctx, app, row);
    });
    r.get(`/${app.file}`, `${pascal(app.file)}s`, async (req) => {
      const ctx = await loadContext(app);
      const f = typeFilter(app);
      const where = [f.sql, "s.has_file = 1", "s.file_path IS NOT NULL"];
      const params: unknown[] = [...f.params];
      if (req.query[app.parentKey] !== undefined) {
        where.push("s.media_item_id = ?");
        params.push(numericId(String(req.query[app.parentKey]), app.parentKey));
      }
      const subIds = idList(req.query[childKey]).concat(idList(req.query[`${child}Id`]));
      if (subIds.length > 0) {
        where.push(`s.id IN (${subIds.map(() => "?").join(",")})`);
        params.push(...subIds);
      }
      const rows = (await db.prepare(`SELECT s.* FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE ${where.join(" AND ")} ORDER BY s.id`).all(...params)) as any[];
      return rows.map((row) => subItemFileResource(ctx, app, row));
    });
    r.get(`/${app.file}/:id`, `One ${app.file}`, async (req) => {
      const ctx = await loadContext(app);
      const f = typeFilter(app);
      const row = await db.prepare(`SELECT s.* FROM sub_items s JOIN media_items m ON m.id = s.media_item_id WHERE s.id = ? AND ${f.sql}`).get(numericId(req.params.id), ...f.params);
      const file = row ? subItemFileResource(ctx, app, row) : null;
      if (!file) throw new HttpError(404, "NotFound");
      return file;
    });
  }
}

export { artistResource, authorResource, seriesResource, subItemStats };
