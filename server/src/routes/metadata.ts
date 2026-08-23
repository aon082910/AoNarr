import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/client.js";
import { mediaItemFromRow } from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import {
  fetchArtistAlbumsFor,
  fetchCollectionChildrenFor,
  fetchSeriesEpisodesFor,
  METADATA_PROVIDERS,
  searchMetadata,
} from "../services/metadata.js";
import { getMediaTypeConfig } from "../services/mediaTypes.js";
import { findPossibleDuplicates } from "../services/duplicateCheck.js";
import { isExcluded } from "../services/importExclusions.js";
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
      const annotated = results.map((r: any) => ({
        ...r,
        excluded: isExcluded(type, r.title, r.year ?? null),
      }));
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
      const duplicates = findPossibleDuplicates(b.type, b.title, b.year ?? null);
      if (duplicates.length > 0) {
        res.status(409).json({ duplicates });
        return;
      }
    }

    const externalIds = b.externalIds ?? {};

    const result = db
      .prepare(
        `INSERT INTO media_items
         (type, title, sort_title, year, overview, poster_url, external_ids, root_folder_id, quality_profile_id, monitored, status, group_id)
         VALUES (@type, @title, @sortTitle, @year, @overview, @posterUrl, @externalIds, @rootFolderId, @qualityProfileId, @monitored, @status, @groupId)`
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
      });

    const mediaItemId = result.lastInsertRowid;
    let childCount = 0;

    try {
      const typeConfig = getMediaTypeConfig(b.type);

      if (typeConfig.shape === "episodic") {
        const episodes = await fetchSeriesEpisodesFor(externalIds);
        const insert = db.prepare(
          `INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, overview, monitored)
           VALUES (?, ?, ?, ?, ?, ?, 1)`
        );
        const insertMany = db.transaction((rows: typeof episodes) => {
          for (const ep of rows) {
            insert.run(mediaItemId, ep.seasonNumber, ep.episodeNumber, ep.title, ep.airDate, ep.overview);
          }
        });
        insertMany(episodes);
        childCount = episodes.length;
      } else if (typeConfig.shape === "collection" && typeConfig.multiFilePerChild) {
        const result = await fetchArtistAlbumsFor(externalIds);
        if (result) {
          const insert = db.prepare(
            `INSERT INTO sub_items (media_item_id, title, release_date, external_id, external_provider, monitored)
             VALUES (?, ?, ?, ?, ?, 1)`
          );
          const insertMany = db.transaction((rows: typeof result.albums) => {
            for (const album of rows) {
              insert.run(mediaItemId, album.title, album.releaseDate, album.externalId ?? null, result.provider);
            }
          });
          insertMany(result.albums);
          childCount = result.albums.length;
        }
      } else if (typeConfig.shape === "collection") {
        const result = await fetchCollectionChildrenFor(externalIds);
        const insert = db.prepare(
          `INSERT INTO sub_items (media_item_id, title, release_date, external_id, external_provider, monitored)
           VALUES (?, ?, ?, ?, ?, 1)`
        );
        const insertMany = db.transaction((rows: typeof result.children) => {
          for (const child of rows) {
            insert.run(mediaItemId, child.title, child.releaseDate, child.externalId ?? null, result.provider);
          }
        });
        insertMany(result.children);
        childCount = result.children.length;
      }
    } catch (err) {
      // The media item itself was created successfully; a failed child fetch (e.g. missing
      // API key) shouldn't roll that back, just surface it so the UI can inform the user.
      console.warn(`[metadata] failed to import children for media item ${mediaItemId}:`, (err as Error).message);
    }

    const row = db.prepare("SELECT * FROM media_items WHERE id = ?").get(mediaItemId);
    res.status(201).json({ ...mediaItemFromRow(row), childCount });
  })
);
