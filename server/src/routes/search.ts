import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { db } from "../db/index.js";
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
import { notifyQueueChanged } from "../services/realtime.js";
import { scoreRelease } from "../services/customFormatScoring.js";
import { log } from "../services/logger.js";
import { sizeWithinQualityBounds } from "../services/quality.js";
import { getBlocklistedTitles, isBlocklisted } from "../services/blocklist.js";
import { searchSlskd } from "../services/soulseek.js";
import { pickClientForProtocol, searchAndGrabTargets, type BulkSearchTarget } from "../services/scheduler.js";
import { computeAbsoluteEpisodeNumber } from "../services/importer.js";
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
  rejected: boolean;
  rejectReason?: string;
  /** Other indexers that also carry what looks like this exact same release (same normalized
   * title + exact size) — collapsed into the best-ranked copy instead of showing N separate rows
   * for what's really one release someone happened to post to multiple trackers. */
  alsoOnIndexers?: string[];
}

/** Same normalization releaseParser.ts-adjacent code doesn't already do: lowercase, collapse all
 * whitespace/punctuation runs to a single space, trim. Deliberately coarse (not the same as
 * releaseGroup/quality parsing) — this only needs to tell "basically the same release" apart from
 * "a different release", not extract structured fields from it. */
function normalizeForDedup(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Collapses near-identical releases (same normalized title, same exact size) posted to more than
 * one indexer into a single row — keeps whichever copy sorted first (the caller's own ranking
 * already puts the best copy first), and records the rest as `alsoOnIndexers`. Size must match
 * exactly (not fuzzy) — two different releases can coincidentally share a title. A `size` of 0
 * isn't a real measured size, though — several indexer adapters use it as a "size unknown"
 * sentinel when an indexer doesn't report one — so two different size-less releases would
 * otherwise collide on title alone; fall back to the download URL to tell them apart in that case. */
function dedupeResults(results: AnnotatedSearchResult[]): AnnotatedSearchResult[] {
  const byKey = new Map<string, AnnotatedSearchResult>();
  const order: string[] = [];
  for (const r of results) {
    const key = r.size > 0 ? `${normalizeForDedup(r.title)}::${r.size}` : `${normalizeForDedup(r.title)}::0::${r.downloadUrl}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, r);
      order.push(key);
    } else if (r.indexerName && r.indexerName !== existing.indexerName) {
      (existing.alsoOnIndexers ??= []).push(r.indexerName);
    }
  }
  return order.map((key) => byKey.get(key)!);
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
    const itemRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.mediaItemId);
    if (!itemRow) throw new HttpError(404, "Media item not found");
    const item = mediaItemFromRow(itemRow);

    let query = item.year ? `${item.title} ${item.year}` : item.title;
    let targetSeason: number | null = null;
    let targetEpisode: number | null = null;
    let targetSceneSeason: number | null = null;
    let targetSceneEpisode: number | null = null;
    let targetAbsoluteEpisode: number | null = null;

    const episodeId = req.query.episodeId as string | undefined;
    const subItemId = req.query.subItemId as string | undefined;
    const seasonNumberParam = req.query.seasonNumber as string | undefined;

    if (episodeId) {
      const ep = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(episodeId)) as any;
      if (!ep) throw new HttpError(404, "Episode not found");
      targetSeason = ep.season_number;
      targetEpisode = ep.episode_number;
      targetSceneSeason = ep.scene_season_number;
      targetSceneEpisode = ep.scene_episode_number;
      targetAbsoluteEpisode = item.type === "anime" ? await computeAbsoluteEpisodeNumber(item.id, ep.season_number, ep.episode_number) : null;
      // Scene-numbered (TheXEM) query when known — see scheduler.ts's own runAutoSearch for why.
      const seasonStr = String(targetSceneSeason ?? targetSeason).padStart(2, "0");
      const episodeStr = String(targetSceneEpisode ?? targetEpisode).padStart(2, "0");
      query = `${item.title} S${seasonStr}E${episodeStr}`;
    } else if (seasonNumberParam) {
      // Season-only (no specific episode) — surfaces full-season pack releases, which a
      // per-episode query wouldn't reliably match against.
      targetSeason = Number(seasonNumberParam);
      const seasonStr = String(targetSeason).padStart(2, "0");
      query = `${item.title} S${seasonStr}`;
    } else if (subItemId) {
      const sub = (await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(subItemId)) as any;
      if (!sub) throw new HttpError(404, "Sub-item not found");
      query = `${item.title} ${sub.title}`;
    }

    const indexers = ((await db.prepare("SELECT * FROM indexers WHERE enabled = 1").all()) as any[]).map(
      indexerFromRow
    );
    const rawResults = await searchAllIndexers(indexers as any, query, item.type as any, true);

    // Soulseek has no Torznab-style indexer — a configured, enabled slskd client is queried
    // directly instead and its results merged in alongside the indexer ones. Music-shaped
    // libraries only, since (user, filename) results from Soulseek only make sense there.
    if (item.type === "artist") {
      const slskdClients = ((await db.prepare("SELECT * FROM download_clients WHERE type = 'slskd' AND enabled = 1").all()) as any[]).map(
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
      const profileRow = await db.prepare("SELECT * FROM quality_profiles WHERE id = ?").get(item.qualityProfileId);
      if (profileRow) {
        const profile = qualityProfileFromRow(profileRow);
        allowedQualities = profile.allowedQualities;
        cutoff = profile.cutoff;
      }
    }

    const blocklisted = await getBlocklistedTitles(item.id);
    const annotated: AnnotatedSearchResult[] = await Promise.all(rawResults.map(async (r) => {
      const parsed = parseReleaseTitle(r.title);
      const matchesTarget =
        targetSeason !== null && targetEpisode !== null
          ? releaseMatchesEpisode(parsed, targetSeason, targetEpisode, targetSceneSeason, targetSceneEpisode, targetAbsoluteEpisode)
          : targetSeason !== null
            ? parsed.seasonNumber === targetSeason
            : true;
      const { totalScore, matches, rejected, rejectReason } = await scoreRelease(
        r.title,
        r.size ?? null,
        item.qualityProfileId,
        item.type,
        r.downloadVolumeFactor ?? null
      );
      return {
        ...r,
        parsedQuality: parsed.quality,
        matchesTarget,
        allowedByProfile: allowedQualities.length === 0 || allowedQualities.includes(parsed.quality),
        sizeAllowed: sizeWithinQualityBounds(parsed.quality, r.size ?? null),
        formatScore: totalScore,
        formatMatches: matches.map((m) => m.name),
        blocklisted: blocklisted.has(r.title),
        rejected,
        rejectReason,
      };
    }));

    // Previously returned in whatever order the indexer itself gave back — an indexer's own
    // relevance ranking has no idea what "matches this specific season/episode" or "meets this
    // profile" mean, so an unrelated show whose title happens to share a word (or a wrong-season
    // episode of the right show) could easily outrank the actual target. Sort by the same signals
    // an automatic grab already weighs — real match first, then profile-allowed, not blocklisted,
    // format score, then seeders — so the top of the list is what auto-search would actually pick,
    // not just whatever the indexer happened to return first.
    annotated.sort(
      (a, b) =>
        Number(b.matchesTarget) - Number(a.matchesTarget) ||
        Number(b.allowedByProfile) - Number(a.allowedByProfile) ||
        Number(a.rejected) - Number(b.rejected) ||
        Number(a.blocklisted) - Number(b.blocklisted) ||
        b.formatScore - a.formatScore ||
        (b.seeders ?? 0) - (a.seeders ?? 0)
    );

    res.json(dedupeResults(annotated));
  })
);

/** Manual grab: POST /api/search/:mediaItemId/grab */
searchRouter.post(
  "/:mediaItemId/grab",
  asyncHandler(async (req, res) => {
    const itemRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.mediaItemId);
    if (!itemRow) throw new HttpError(404, "Media item not found");
    const item = mediaItemFromRow(itemRow);

    const b = req.body ?? {};
    if (!b.downloadUrl) throw new HttpError(400, "downloadUrl is required");
    if (b.title && (await isBlocklisted(Number(req.params.mediaItemId), b.title))) {
      throw new HttpError(400, "This release is blocklisted for this media item");
    }

    // Either an explicit client id, or (the UI's normal path) the release's protocol — an NZB
    // handed to qBittorrent, or a torrent to a disabled client, just fails at the client.
    let clientRow: unknown;
    if (b.downloadClientId) {
      clientRow = await db.prepare("SELECT * FROM download_clients WHERE id = ?").get(b.downloadClientId);
      if (!clientRow) throw new HttpError(404, "Download client not found");
    } else {
      const enabled = ((await db.prepare("SELECT * FROM download_clients WHERE enabled = 1").all()) as any[]).map(downloadClientFromRow);
      if (enabled.length === 0) throw new HttpError(400, "Add and enable a download client first");
      const protocol =
        b.protocol === "usenet" || b.protocol === "torrent" || b.protocol === "http" || b.protocol === "slskd" ? b.protocol : "torrent";
      const picked = pickClientForProtocol(enabled as any, protocol);
      if (!picked) throw new HttpError(400, `No enabled download client can handle a "${protocol}" release`);
      clientRow = await db.prepare("SELECT * FROM download_clients WHERE id = ?").get(picked.id);
    }
    const client = downloadClientFromRow(clientRow) as any;

    const adapter = getDownloadClientAdapter(client.type);
    const grab = await adapter.addDownload(client, b.downloadUrl, client.category, b.title);
    const quality = parseReleaseTitle(b.title ?? "").quality;

    const result = await db
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

    await db.prepare(`INSERT INTO history (media_item_id, event_type, data) VALUES (?, 'grabbed', ?)`).run(
      req.params.mediaItemId,
      JSON.stringify(b)
    );

    notifyGrabbed(item.title, b.title ?? "Unknown release").catch((err) =>
      log.warn("[search] notification failed:", err.message)
    );
    notifyQueueChanged();

    const queueRow = await db.prepare("SELECT * FROM queue WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(queueItemFromRow(queueRow));
  })
);
