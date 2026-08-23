import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/client.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { searchMetadata, fetchSeriesEpisodesFor } from "../services/metadata.js";
import { findPossibleDuplicates } from "../services/duplicateCheck.js";
import { queueForReview } from "../services/importReview.js";
import { log } from "../services/logger.js";
import type { MediaType } from "../types/index.js";

export const watchlistImportRouter = Router();
watchlistImportRouter.use(requireAdmin);

interface WatchlistRow {
  title: string;
  year: number | null;
  type: MediaType;
}

interface RowResult {
  title: string;
  status: "added" | "skipped_duplicate" | "not_found" | "error";
  detail?: string;
}

/**
 * Bulk-imports a parsed watchlist export (IMDb "Your Watchlist" CSV, Letterboxd watchlist.csv,
 * Trakt CSV export — the web UI normalizes whichever headers it finds into {title, year, type}
 * before posting here) by metadata-searching each title and adding the top match as monitored,
 * same pipeline as a single Add Media import. Duplicates are skipped automatically rather than
 * prompted one-by-one, since this can be dozens/hundreds of rows. A title the metadata search
 * comes up empty for is queued in import_review_items (see services/importReview.ts) for manual
 * matching later, rather than just vanishing — see the Import Review page.
 */
watchlistImportRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const rows: WatchlistRow[] = req.body?.rows;
    if (!Array.isArray(rows) || rows.length === 0) throw new HttpError(400, "rows is required");
    if (rows.length > 500) throw new HttpError(400, "Too many rows in one import (max 500)");

    const qualityProfileId = (
      db.prepare("SELECT id FROM quality_profiles ORDER BY id LIMIT 1").get() as { id: number } | undefined
    )?.id ?? null;

    const results: RowResult[] = [];

    for (const row of rows) {
      if (!row.title) continue;
      try {
        if (findPossibleDuplicates(row.type, row.title, row.year).length > 0) {
          results.push({ title: row.title, status: "skipped_duplicate" });
          continue;
        }

        const query = row.year ? `${row.title} ${row.year}` : row.title;
        const searchResults = await searchMetadata(row.type, query).catch(() => []);
        const best = searchResults[0];
        if (!best) {
          queueForReview({ source: "watchlist", importListId: null, type: row.type, title: row.title, year: row.year });
          results.push({ title: row.title, status: "not_found" });
          continue;
        }

        const insertResult = db
          .prepare(
            `INSERT INTO media_items (type, title, sort_title, year, overview, poster_url, external_ids, quality_profile_id, monitored, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'missing')`
          )
          .run(
            row.type,
            best.title,
            best.title.toLowerCase(),
            best.year,
            best.overview,
            best.posterUrl,
            JSON.stringify(best.externalIds),
            qualityProfileId
          );

        if (row.type === "series") {
          const mediaItemId = insertResult.lastInsertRowid;
          const episodes = await fetchSeriesEpisodesFor(best.externalIds).catch(() => []);
          const insertEp = db.prepare(
            `INSERT INTO episodes (media_item_id, season_number, episode_number, title, air_date, overview, monitored)
             VALUES (?, ?, ?, ?, ?, ?, 1)`
          );
          for (const ep of episodes) insertEp.run(mediaItemId, ep.seasonNumber, ep.episodeNumber, ep.title, ep.airDate, ep.overview);
        }

        results.push({ title: row.title, status: "added" });
      } catch (err) {
        log.warn(`[watchlist-import] failed for "${row.title}":`, (err as Error).message);
        results.push({ title: row.title, status: "error", detail: (err as Error).message });
      }
    }

    res.json({ results });
  })
);
