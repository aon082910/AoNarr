import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { mediaItemFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import {
  fetchArtistAlbumsFor,
  fetchByExternalId,
  fetchCollectionChildrenFor,
  fetchRomDetailsFor,
  fetchSeriesEpisodesFor,
  METADATA_PROVIDERS,
  parseProviderUrl,
  searchMetadata,
} from "../services/metadata.js";
import { insertTracksForAlbum } from "../services/importLists.js";
import { getMediaTypeConfig } from "../services/mediaTypes.js";
import { findPossibleDuplicates } from "../services/duplicateCheck.js";
import { isExcluded } from "../services/importExclusions.js";
import { log } from "../services/logger.js";
import { logAuditEvent } from "../services/audit.js";
import { getSetting } from "../services/settingsStore.js";
import { createLibraryFolderSkeleton } from "../services/importer.js";
import { syncSceneNumbering } from "../services/sceneNumbering.js";
import { autoSelectRootFolderId } from "../services/rootFolderSelect.js";
import type { MediaType } from "../types/index.js";

/**
 * Sonarr's "Monitor" dropdown when adding a series — decides which of the freshly-fetched
 * episodes stay monitored (auto-searched) versus not, beyond the previous all-or-nothing. Since
 * this only ever runs against a *brand new* add (nothing downloaded yet), "Existing Episodes"
 * correctly comes out to "monitor nothing" here — there's nothing existing yet to monitor.
 */
function episodesToMonitor(
  episodes: { seasonNumber: number; episodeNumber: number; airDate: string | null }[],
  strategy: string
): Set<string> {
  const key = (s: number, e: number) => `${s}:${e}`;
  const realSeasons = episodes.map((e) => e.seasonNumber).filter((s) => s > 0);
  const minSeason = realSeasons.length > 0 ? Math.min(...realSeasons) : 0;
  const maxSeason = realSeasons.length > 0 ? Math.max(...realSeasons) : 0;
  const today = new Date().toISOString().slice(0, 10);

  switch (strategy) {
    case "none":
    case "existing":
      return new Set();
    case "future":
      return new Set(
        episodes.filter((e) => !e.airDate || e.airDate.slice(0, 10) >= today).map((e) => key(e.seasonNumber, e.episodeNumber))
      );
    case "recent":
    case "latestSeason":
      return new Set(episodes.filter((e) => e.seasonNumber === maxSeason).map((e) => key(e.seasonNumber, e.episodeNumber)));
    case "firstSeason":
      return new Set(episodes.filter((e) => e.seasonNumber === minSeason).map((e) => key(e.seasonNumber, e.episodeNumber)));
    case "pilot":
      return new Set([key(minSeason, 1)]);
    case "missing":
    case "all":
    default:
      return new Set(episodes.map((e) => key(e.seasonNumber, e.episodeNumber)));
  }
}

export const metadataRouter = Router();
metadataRouter.use(requireAdmin);

metadataRouter.get(
  "/providers",
  asyncHandler(async (_req, res) => {
    res.json(METADATA_PROVIDERS);
  })
);

metadataRouter.get(
  "/search",
  asyncHandler(async (req, res) => {
    const type = req.query.type as MediaType | undefined;
    const query = req.query.query as string | undefined;
    const provider = req.query.provider as string | undefined;
    const yearRaw = req.query.year as string | undefined;
    const year = yearRaw ? parseInt(yearRaw, 10) : null;
    if (!type || !query) throw new HttpError(400, "type and query are required");

    try {
      const results = await searchMetadata(type, query, provider, Number.isFinite(year) ? year : null);
      const annotated = await Promise.all(
        results.map(async (r: any) => ({
          ...r,
          excluded: await isExcluded(type, r.title, r.year ?? null),
        }))
      );
      res.json(annotated);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  })
);

/**
 * Radarr/Sonarr-style "match by ID or URL" — an alternative to title search on Add Media and the
 * "search for a different match" rematch modal. `input` is either a bare provider id (ISBN,
 * "tt1234567", a numeric TMDB/TVDB/AniList/IGDB/RAWG id) or a full URL copy-pasted from one of
 * those providers' own sites; a recognized URL shape wins over the `provider` query param (the id
 * embedded in the URL is unambiguous about which provider it belongs to). Returns a single result
 * in the same array shape /search returns, so the frontend can reuse its existing results list.
 */
metadataRouter.get(
  "/match",
  asyncHandler(async (req, res) => {
    const type = req.query.type as MediaType | undefined;
    const input = (req.query.input as string | undefined)?.trim();
    let provider = req.query.provider as string | undefined;
    if (!type || !input) throw new HttpError(400, "type and input are required");

    const fromUrl = parseProviderUrl(input);
    const id = fromUrl ? fromUrl.id : input;
    // The provider dropdown reused from title search only ever lists that type's own title-search
    // providers (tmdb/omdb for movies, openlibrary/googlebooks for authors, ...) — none of which
    // are "imdb"/"isbn", so a bare id in one of those two unambiguous shapes is auto-detected
    // regardless of whatever the dropdown happens to be set to. Numeric ids stay genuinely
    // ambiguous across tmdb/tvdb/anilist/igdb/rawg and still need the dropdown's own selection.
    if (fromUrl) {
      provider = fromUrl.provider;
    } else if (/^tt\d+$/i.test(id)) {
      provider = "imdb";
    } else if (type === "author" && /^[\dXx][\dXx\- ]{8,16}[\dXx]$/.test(id)) {
      provider = "isbn";
    }
    if (!provider) throw new HttpError(400, "provider is required when input isn't a recognized provider URL");

    try {
      const result = await fetchByExternalId(type, provider, id);
      res.json([{ ...result, excluded: await isExcluded(type, result.title, result.year ?? null) }]);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  })
);

/** Overview + System (platform) + Maker (developer/publisher) for one ROM search result, fetched
 * on demand once the user picks it on Add Media — RAWG/IGDB's search endpoints don't return this,
 * only their per-game detail lookup does. Used to auto-fill the overview field and pre-select/
 * create the System → Maker group chain instead of making the user type both by hand. */
metadataRouter.get(
  "/rom-details",
  asyncHandler(async (req, res) => {
    const provider = req.query.provider as string | undefined;
    const externalId = req.query.externalId as string | undefined;
    if (!provider || !externalId) throw new HttpError(400, "provider and externalId are required");
    try {
      const details = await fetchRomDetailsFor({ [provider]: externalId });
      res.json(details ?? { overview: null, system: null, maker: null });
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  })
);

/**
 * Creates a media item from a metadata search result and, for series/artist/author, eagerly
 * fetches and inserts the full episode/album/book list so the library is immediately browsable.
 */
metadataRouter.post(
  "/import",
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.type || !b.title) throw new HttpError(400, "type and title are required");

    if (!b.confirmDuplicate) {
      const duplicates = await findPossibleDuplicates(b.type, b.title, b.year ?? null);
      if (duplicates.length > 0) {
        res.status(409).json({ duplicates });
        return;
      }
    }

    const externalIds = b.externalIds ?? {};
    const rootFolderId = b.rootFolderId ?? (await autoSelectRootFolderId(b.type));

    const result = await db
      .prepare(
        `INSERT INTO media_items
         (type, title, sort_title, year, overview, poster_url, external_ids, root_folder_id, quality_profile_id, monitored, status, group_id, release_date, minimum_availability, series_type, backdrop_url, rating, runtime_minutes, studio, extra_metadata)
         VALUES (@type, @title, @sortTitle, @year, @overview, @posterUrl, @externalIds, @rootFolderId, @qualityProfileId, @monitored, @status, @groupId, @releaseDate, @minimumAvailability, @seriesType, @backdropUrl, @rating, @runtimeMinutes, @studio, @extraMetadata)`
      )
      .run({
        type: b.type,
        title: b.title,
        sortTitle: b.title.toLowerCase(),
        year: b.year ?? null,
        overview: b.overview ?? null,
        posterUrl: b.posterUrl ?? null,
        externalIds: JSON.stringify(externalIds),
        rootFolderId,
        qualityProfileId: b.qualityProfileId ?? null,
        monitored: b.monitored ?? 1,
        status: "unknown",
        groupId: b.groupId ?? null,
        releaseDate: b.releaseDate ?? null,
        minimumAvailability: b.minimumAvailability ?? getSetting("defaultMinimumAvailability") ?? "announced",
        seriesType: b.seriesType ?? null,
        backdropUrl: b.backdropUrl ?? null,
        rating: b.rating ?? null,
        runtimeMinutes: b.runtimeMinutes ?? null,
        studio: b.studio ?? null,
        // Whisparr-style performer tracking, scoped to "store what ThePornDB gave us" rather than
        // a full performer-as-entity system (no dedicated performer pages/filtering) — see
        // searchAdultThePornDb in metadata.ts for where this comes from.
        extraMetadata: Array.isArray(b.performers) && b.performers.length > 0 ? JSON.stringify({ performers: b.performers }) : null,
      });

    const mediaItemId = result.lastInsertRowid;
    let childCount = 0;

    if (getSetting("createEmptyFoldersOnAdd") === "1" && rootFolderId) {
      const rootFolderRow = (await db.prepare("SELECT path FROM root_folders WHERE id = ?").get(rootFolderId)) as
        | { path: string }
        | undefined;
      if (rootFolderRow) createLibraryFolderSkeleton({ type: b.type, title: b.title, year: b.year ?? null }, rootFolderRow.path);
    }

    try {
      const typeConfig = getMediaTypeConfig(b.type);

      if (typeConfig.shape === "episodic") {
        const episodes = await fetchSeriesEpisodesFor(externalIds);
        // Running count across every season > 0 (specials excluded), sorted first — same absolute-
        // numbering convention importer.ts already computes for path templating, now also stored
        // per-episode so it can be used as a release-matching signal (anime fansub releases are
        // very often numbered "Show - 145" with no season/episode designator at all).
        const absoluteOrder = [...episodes]
          .filter((e) => e.seasonNumber > 0)
          .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
        const absoluteByKey = new Map<string, number>();
        absoluteOrder.forEach((e, idx) => absoluteByKey.set(`${e.seasonNumber}:${e.episodeNumber}`, idx + 1));

        await db.transaction(async () => {
          for (const ep of episodes) {
            await db
              .prepare(
                `INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, overview, monitored, absolute_episode_number)
                 VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
              )
              .run(
                mediaItemId,
                ep.seasonNumber,
                ep.episodeNumber,
                ep.title,
                ep.airDate,
                ep.overview,
                absoluteByKey.get(`${ep.seasonNumber}:${ep.episodeNumber}`) ?? null
              );
          }
        });
        childCount = episodes.length;

        if (b.monitorStrategy && b.monitorStrategy !== "all") {
          const keep = episodesToMonitor(episodes, b.monitorStrategy);
          const toUnmonitor = episodes.filter((e) => !keep.has(`${e.seasonNumber}:${e.episodeNumber}`));
          if (toUnmonitor.length > 0) {
            await db.transaction(async () => {
              for (const e of toUnmonitor) {
                await db
                  .prepare("UPDATE episodes SET monitored = 0 WHERE media_item_id = ? AND season_number = ? AND episode_number = ?")
                  .run(mediaItemId, e.seasonNumber, e.episodeNumber);
              }
            });
          }
        }

        // Best-effort, fire-and-forget — a slow/unreachable thexem.info shouldn't hold up adding
        // the series itself, same reasoning as every other post-add enrichment call in this file.
        syncSceneNumbering(Number(mediaItemId)).catch((err) => log.warn(`[metadata] scene numbering sync failed for ${b.title}:`, (err as Error).message));
      } else if (typeConfig.shape === "collection" && typeConfig.multiFilePerChild) {
        const result = await fetchArtistAlbumsFor(externalIds);
        if (result) {
          // A provider occasionally returns an entry with no title (a data-quality gap on their
          // end, e.g. Open Library "works" with a title-less record) — sub_items.title is NOT
          // NULL, and since insertMany runs as one transaction, a single bad entry would otherwise
          // roll back every good entry in the batch along with it.
          const albums = result.albums.filter((a) => a.title);
          const insertedAlbumIds: { id: number | bigint; externalId: string }[] = [];
          await db.transaction(async () => {
            for (const album of albums) {
              const insertResult = await db
                .prepare(
                  `INSERT INTO sub_items (media_item_id, title, release_date, external_id, external_provider, monitored, poster_url)
                   VALUES (?, ?, ?, ?, ?, 1, ?)`
                )
                .run(mediaItemId, album.title, album.releaseDate, album.externalId ?? null, result.provider, album.posterUrl ?? null);
              if (album.externalId && insertResult.lastInsertRowid != null) {
                insertedAlbumIds.push({ id: insertResult.lastInsertRowid, externalId: album.externalId });
              }
            }
          });
          childCount = albums.length;

          // Track listings are fetched one album at a time (real network calls, not something
          // that should hold a Postgres transaction's connection open for their entire duration —
          // see insertTracksForAlbum's own note) after the albums themselves are safely committed,
          // so an artist with dozens of albums doesn't leave its own add half-finished if one
          // album's track fetch is slow or fails. Without this, a newly-added artist's albums sat
          // with an empty track list until an admin clicked "Fetch tracks" on each one by hand.
          for (const { id, externalId } of insertedAlbumIds) {
            await insertTracksForAlbum(id, result.provider, externalId);
          }
        }
      } else if (typeConfig.shape === "collection") {
        const result = await fetchCollectionChildrenFor(externalIds);
        const children = result.children.filter((c) => c.title);
        await db.transaction(async () => {
          for (const child of children) {
            await db
              .prepare(
                `INSERT INTO sub_items (media_item_id, title, release_date, external_id, external_provider, monitored)
                 VALUES (?, ?, ?, ?, ?, 1)`
              )
              .run(mediaItemId, child.title, child.releaseDate, child.externalId ?? null, result.provider);
          }
        });
        childCount = children.length;
      }
    } catch (err) {
      // The media item itself was created successfully; a failed child fetch (e.g. missing
      // API key, or a malformed provider URL like the Open Library bug this class of failure
      // used to hide) shouldn't roll that back, just surface it so the UI/Logs page can inform
      // the user instead of the item silently sitting there with zero children forever.
      log.warn(`[metadata] failed to import children for media item ${mediaItemId}:`, (err as Error).message);
    }

    const row = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(mediaItemId);
    const actor = req.auth?.user ? { userId: req.auth.user.id, username: req.auth.user.username } : { userId: null, username: "admin" };
    logAuditEvent(actor.userId, actor.username, "media_added", `${b.title} (${b.type})`);
    res.status(201).json({ ...mediaItemFromRow(row), childCount });
  })
);
