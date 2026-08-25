import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { mediaItemFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import {
  fetchArtistAlbumsFor,
  fetchCollectionChildrenFor,
  fetchSeriesEpisodesFor,
  METADATA_PROVIDERS,
  searchMetadata,
} from "../services/metadata.js";
import { insertTracksForAlbum } from "../services/importLists.js";
import { getMediaTypeConfig } from "../services/mediaTypes.js";
import { findPossibleDuplicates } from "../services/duplicateCheck.js";
import { isExcluded } from "../services/importExclusions.js";
import { log } from "../services/logger.js";
import { logAuditEvent } from "../services/audit.js";
import { getSetting } from "../services/settingsStore.js";
import type { MediaType } from "../types/index.js";

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
    if (!type || !query) throw new HttpError(400, "type and query are required");

    try {
      const results = await searchMetadata(type, query, provider);
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

    const result = await db
      .prepare(
        `INSERT INTO media_items
         (type, title, sort_title, year, overview, poster_url, external_ids, root_folder_id, quality_profile_id, monitored, status, group_id, release_date, minimum_availability)
         VALUES (@type, @title, @sortTitle, @year, @overview, @posterUrl, @externalIds, @rootFolderId, @qualityProfileId, @monitored, @status, @groupId, @releaseDate, @minimumAvailability)`
      )
      .run({
        type: b.type,
        title: b.title,
        sortTitle: b.title.toLowerCase(),
        year: b.year ?? null,
        overview: b.overview ?? null,
        posterUrl: b.posterUrl ?? null,
        externalIds: JSON.stringify(externalIds),
        rootFolderId: b.rootFolderId ?? null,
        qualityProfileId: b.qualityProfileId ?? null,
        monitored: b.monitored ?? 1,
        status: "unknown",
        groupId: b.groupId ?? null,
        releaseDate: b.releaseDate ?? null,
        minimumAvailability: b.minimumAvailability ?? getSetting("defaultMinimumAvailability") ?? "announced",
      });

    const mediaItemId = result.lastInsertRowid;
    let childCount = 0;

    try {
      const typeConfig = getMediaTypeConfig(b.type);

      if (typeConfig.shape === "episodic") {
        const episodes = await fetchSeriesEpisodesFor(externalIds);
        await db.transaction(async () => {
          for (const ep of episodes) {
            await db
              .prepare(
                `INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, overview, monitored)
                 VALUES (?, ?, ?, ?, ?, ?, 1)`
              )
              .run(mediaItemId, ep.seasonNumber, ep.episodeNumber, ep.title, ep.airDate, ep.overview);
          }
        });
        childCount = episodes.length;
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
