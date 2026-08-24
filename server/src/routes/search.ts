import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/client.js";
import {
  downloadClientFromRow,
  indexerFromRow,
  mediaItemFromRow,
  qualityProfileFromRow,
  queueItemFromRow,
} from "../db/mappers.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { searchAllIndexers } from "../services/indexerClient.js";
import { getDownloadClientAdapter } from "../services/downloadClient.js";
import { parseReleaseTitle, releaseMatchesEpisode } from "../services/releaseParser.js";
import { notifyGrabbed } from "../services/notifications.js";
import { scoreRelease } from "../services/customFormatScoring.js";
import { log } from "../services/logger.js";
import { sizeWithinQualityBounds } from "../services/quality.js";
import { getBlocklistedTitles, isBlocklisted } from "../services/blocklist.js";
import { searchSlskd } from "../services/soulseek.js";
import { searchAndGrabTargets, type BulkSearchTarget } from "../services/scheduler.js";
import type { SearchResult } from "../types/index.js";

export const searchRouter = Router();
searchRouter.use(requireAdmin);

/** Bulk search: POST /api/search/bulk — body: { targets: BulkSearchTarget[] }. Runs sequentially
 * (each target does a full indexer search) and returns per-target results, backing the
 * Library/Missing pages' multi-select "Search selected" action. */
searchRouter.post(
  "/bulk",
  asyncHandler(async (req, res) => {
    const targets: BulkSearchTarget[] = req.body?.targets;
    if (!Array.isArray(targets) || targets.length === 0) throw new HttpError(400, "targets is required");
    if (targets.length > 100) throw new HttpError(400, "Too many targets in one bulk search (max 100)");
    const results = await searchAndGrabTargets(targets);
    res.json(results);
  })
);

export interface AnnotatedSearchResult extends SearchResult {
  parsedQuality: string;
  matchesTarget: boolean;
  allowedByProfile: boolean;
  sizeAllowed: boolean;
  formatScore: number;
  formatMatches: string[];
  blocklisted: boolean;
}

/**
 * Manual search: GET /api/search/:mediaItemId?episodeId=&subItemId=
 * For series/artist/author, passing episodeId or subItemId narrows the query to that specific
 * episode/album/book and flags which results actually match it (season packs still surface,
 * just annotated). Results are annotated with parsed quality and whether the profile allows it.
 */
searchRouter.get(
  "/:mediaItemId",
  asyncHandler(async (req, res) => {
    const itemRow = db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.mediaItemId);
    if (!itemRow) throw new HttpError(404, "Media item not found");
    const item = mediaItemFromRow(itemRow);

    let query = item.year ? `${item.title} ${item.year}` : item.title;
    let targetSeason: number | null = null;
    let targetEpisode: number | null = null;

    const episodeId = req.query.episodeId as string | undefined;
    const subItemId = req.query.subItemId as string | undefined;
    const seasonNumberParam = req.query.seasonNumber as string | undefined;

    if (episodeId) {
      const ep = db.prepare("SELECT * FROM episodes WHERE id = ?").get(episodeId) as any;
      if (!ep) throw new HttpError(404, "Episode not found");
      targetSeason = ep.season_number;
      targetEpisode = ep.episode_number;
      const seasonStr = String(targetSeason).padStart(2, "0");
      const episodeStr = String(targetEpisode).padStart(2, "0");
      query = `${item.title} S${seasonStr}E${episodeStr}`;
    } else if (seasonNumberParam) {
      // Season-only (no specific episode) — surfaces full-season pack releases, which a
      // per-episode query wouldn't reliably match against.
      targetSeason = Number(seasonNumberParam);
      const seasonStr = String(targetSeason).padStart(2, "0");
      query = `${item.title} S${seasonStr}`;
    } else if (subItemId) {
      const sub = db.prepare("SELECT * FROM sub_items WHERE id = ?").get(subItemId) as any;
      if (!sub) throw new HttpError(404, "Sub-item not found");
      query = `${item.title} ${sub.title}`;
    }

    const indexers = (db.prepare("SELECT * FROM indexers WHERE enabled = 1").all() as any[]).map(
      indexerFromRow
    );
    const rawResults = await searchAllIndexers(indexers as any, query, item.type as any, true);

    // Soulseek has no Torznab-style indexer — a configured, enabled slskd client is queried
    // directly instead and its results merged in alongside the indexer ones. Music-shaped
    // libraries only, since (user, filename) results from Soulseek only make sense there.
    if (item.type === "artist") {
      const slskdClients = (db.prepare("SELECT * FROM download_clients WHERE type = 'slskd' AND enabled = 1").all() as any[]).map(
        downloadClientFromRow
      );
      for (const client of slskdClients) {
        try {
          rawResults.push(...(await searchSlskd(client as any, query)));
        } catch (err) {
          log.warn(`[search] slskd client "${client.name}" search failed:`, (err as Error).message);
        }
      }
    }

    let allowedQualities: string[] = [];
    let cutoff = "";
    if (item.qualityProfileId) {
      const profileRow = db.prepare("SELECT * FROM quality_profiles WHERE id = ?").get(item.qualityProfileId);
      if (profileRow) {
        const profile = qualityProfileFromRow(profileRow);
        allowedQualities = profile.allowedQualities;
        cutoff = profile.cutoff;
      }
    }

    const blocklisted = await getBlocklistedTitles(item.id);
    const annotated: AnnotatedSearchResult[] = rawResults.map((r) => {
      const parsed = parseReleaseTitle(r.title);
      const matchesTarget =
        targetSeason !== null && targetEpisode !== null
          ? releaseMatchesEpisode(parsed, targetSeason, targetEpisode)
          : targetSeason !== null
            ? parsed.seasonNumber === targetSeason
            : true;
      const { totalScore, matches } = scoreRelease(r.title, r.size ?? null, item.qualityProfileId, item.type);
      return {
        ...r,
        parsedQuality: parsed.quality,
        matchesTarget,
        allowedByProfile: allowedQualities.length === 0 || allowedQualities.includes(parsed.quality),
        sizeAllowed: sizeWithinQualityBounds(parsed.quality, r.size ?? null),
        formatScore: totalScore,
        formatMatches: matches.map((m) => m.name),
        blocklisted: blocklisted.has(r.title),
      };
    });

    res.json(annotated);
  })
);

/** Manual grab: POST /api/search/:mediaItemId/grab */
searchRouter.post(
  "/:mediaItemId/grab",
  asyncHandler(async (req, res) => {
    const itemRow = db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.mediaItemId);
    if (!itemRow) throw new HttpError(404, "Media item not found");
    const item = mediaItemFromRow(itemRow);

    const b = req.body ?? {};
    if (!b.downloadUrl || !b.downloadClientId) {
      throw new HttpError(400, "downloadUrl and downloadClientId are required");
    }
    if (b.title && (await isBlocklisted(Number(req.params.mediaItemId), b.title))) {
      throw new HttpError(400, "This release is blocklisted for this media item");
    }

    const clientRow = db.prepare("SELECT * FROM download_clients WHERE id = ?").get(b.downloadClientId);
    if (!clientRow) throw new HttpError(404, "Download client not found");
    const client = downloadClientFromRow(clientRow) as any;

    const adapter = getDownloadClientAdapter(client.type);
    const grab = await adapter.addDownload(client, b.downloadUrl, client.category, b.title);
    const quality = parseReleaseTitle(b.title ?? "").quality;

    const result = db
      .prepare(
        `INSERT INTO queue (media_item_id, episode_id, sub_item_id, season_number, title, indexer_id, download_client_id, download_id, size, quality, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`
      )
      .run(
        req.params.mediaItemId,
        b.episodeId ?? null,
        b.subItemId ?? null,
        b.episodeId ? null : (b.seasonNumber ?? null),
        b.title ?? "Unknown release",
        b.indexerId ?? null,
        client.id,
        grab.downloadId,
        b.size ?? null,
        quality
      );

    db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'grabbed', ?)`).run(
      req.params.mediaItemId,
      JSON.stringify(b)
    );

    notifyGrabbed(item.title, b.title ?? "Unknown release").catch((err) =>
      log.warn("[search] notification failed:", err.message)
    );

    const queueRow = db.prepare("SELECT * FROM queue WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(queueItemFromRow(queueRow));
  })
);
