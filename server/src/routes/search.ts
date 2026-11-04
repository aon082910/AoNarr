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
import { searchAllIndexers, type IndexerSearchOutcome } from "../services/indexerClient.js";
import { parseReleaseTitle, releaseMatchesAirDate, releaseMatchesEpisode, type SceneIndex } from "../services/releaseParser.js";
import { sceneIndexFor } from "../services/sceneNumbering.js";
import { indexerInfoOf, scoreRelease } from "../services/customFormatScoring.js";
import { log } from "../services/logger.js";
import { groupedRank, knownReleaseSize, qualityRank, sizeWithinQualityBounds, usesQualityTiers } from "../services/quality.js";
import { releaseRuntimeMinutes, runtimeContextFor } from "../services/releaseRuntime.js";
import { compareUsenetAge, comparePeers, protocolGroup, protocolPreferenceKey } from "../services/releaseRanking.js";
import { getBlocklistedTitles, isBlocklisted } from "../services/blocklist.js";
import { isBlockedRelease } from "../services/blocklistMatch.js";
import {
  chooseBestResult,
  existingFileQuality,
  loadDelayProfiles,
  matchTierFor,
  packContextFor,
  pickDelayProfile,
  rowsToDownloadClients,
  tagIdsForMediaItem,
  targetIdentityOf,
  type TargetIdentity,
} from "../services/scheduler.js";
import { discographyPlanFor, episodePlanFor, searchHintsOf, seasonPlanFor, singlePlanFor, subItemPlanFor, type SearchPlan } from "../services/searchPlan.js";
import { identityModeFor, releaseIdentifiesTarget } from "../services/releaseIdentity.js";
import { releaseRejection } from "../services/releaseRejections.js";
import { aliasSeasonsFor, aliasTitlesFor, applyAliasSeason, identityContextFor, identityTargetFor, seasonEpisodeCounts } from "../services/releaseAliases.js";
import { searchSlskd } from "../services/soulseek.js";
import { getMediaTypeConfig } from "../services/mediaTypes.js";
import {
  DownloadClientUnavailableError,
  DuplicateGrabError,
  grab as grabRelease,
  pickClientForProtocol,
  ReleaseRefusedError,
  searchAndGrabTargets,
  type BulkSearchTarget,
} from "../services/scheduler.js";
import { computeAbsoluteEpisodeNumber } from "../services/importer.js";
import { existingFileRecord } from "../services/fileRelease.js";
import { editionlessTitle } from "../services/nonVideoMatch.js";
import { judgeUpgrade, propersMode, upgradeProfileOf } from "../services/upgradeRules.js";
import { getQualityProfile, isAlreadyQueued, isNotYetReleased, releaseNameVerdict, siblingTitlesOf, yearFieldsOf, type TargetName } from "../services/scheduler.js";
import {
  albumsCoveredBy,
  discographyAlbumsOf,
  discographyGrabsEnabled,
  isWantedAlbum,
  judgeDiscography,
  releaseNamesArtist,
  type DiscographyAlbum,
} from "../services/discography.js";
import { availabilityRejectionDetail } from "../services/releaseAvailability.js";
import { freeBytesForItem, freeSpaceCheckEnabled, freeSpaceReason, freeSpaceReserveBytes } from "../services/freeSpace.js";
import { tagIdsOfItem } from "../services/tagScope.js";
import { languageRejection } from "../services/profileLanguage.js";
import { episodesCoveredBy, judgeSeasonPack, packSettings, type PackEpisode } from "../services/seasonPacks.js";
import { ageMinutesOf, buildRejections, emptyFacts, indexerFlagsOf, releaseTypeOf, summarize, type DecisionRejection } from "../services/releaseDecision.js";
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

/** "PROPER", "REPACK", "v2", "REAL PROPER" for a release's revision, null for the original. */
function revisionLabelOf(revision: ReturnType<typeof parseReleaseTitle>["revision"]): string | null {
  if (!revision || (revision.version <= 1 && revision.real === 0)) return null;
  const parts: string[] = [];
  if (revision.real > 0) parts.push("REAL");
  parts.push(revision.isRepack ? "REPACK" : revision.version >= 2 ? "PROPER / v" + revision.version : "");
  return parts.filter(Boolean).join(" ") || null;
}

export interface AnnotatedSearchResult extends SearchResult {
  parsedQuality: string;
  matchesTarget: boolean;
  allowedByProfile: boolean;
  sizeAllowed: boolean;
  formatScore: number;
  formatMatches: string[];
  /** 2 = this release's own reported/title-embedded external id matches the target's; 1 = its
   * parsed year matches; 0 = neither (or not applicable — a sub-item search, which confirms
   * identity by the sub-item's title instead). See scheduler.ts's matchTierFor. */
  matchTier: number;
  /** The identity gate's verdict (services/releaseIdentity.ts) for a quality-tiered type: whether
   * the release names this item at all, how it matched, and why not. Always true/null for a type
   * the gate doesn't judge (music, books, ...). Automatic search rejects a false verdict when the
   * type's `strictReleaseIdentity` mode is `enforce`; a manual grab is refused once with the reason
   * (409) and goes through when repeated with `force: true`. */
  identityOk: boolean;
  identityMatch: string | null;
  identityReason: string | null;
  /** Which check a rejected release failed: only a title rejection is something an alias can fix. */
  identityRejection: "title" | "year" | null;
  /** The title the parser read from the release name — what "add as an alias" would store. */
  parsedTitle: string;
  blocklisted: boolean;
  /** The one release an automatic search of this target would grab (same rejections, quality tier,
   * format score and tie-breaks), so the list can show it first. Always false for a season-only or
   * album/book search, which have no single automatic pick. */
  wouldAutoGrab: boolean;
  /** At least one permanent reason (see `rejections`). A rejected release can still be grabbed by hand. */
  rejected: boolean;
  /** The first permanent reason, else the first reason. */
  rejectReason?: string;
  /** Every reason the release would not be taken, permanent or temporary (Sonarr's `rejections[]`). */
  rejections: DecisionRejection[];
  /** No reason at all. */
  approved: boolean;
  /** Reasons exist and every one ends by itself. */
  temporarilyRejected: boolean;
  /** An enabled download client takes the release's protocol. */
  downloadAllowed: boolean;
  /** Minutes since publication; null when the indexer gave no date. */
  ageMinutes: number | null;
  releaseGroup: string | null;
  languages: string[];
  /** single / season-pack / multi-episode; null for a type without episodes. */
  releaseType: "single" | "season-pack" | "multi-episode" | null;
  /** For a season pack: how many known episodes of its season it covers. */
  episodesCovered: number | null;
  /** For an artist's discography: how many of the artist's albums it covers, and how many of those are missing. */
  discography: { albumsCovered: number; albumsMissing: number } | null;
  /** The quality's place on the ladder, for sorting by quality (-1 when it is not on it). */
  qualityRank: number;
  /** freeleech, halfleech, doubleupload and the indexer's own tags. */
  flags: string[];
  /** 1-based position in the order the server ranked the list (the automatic pick's order). */
  serverRank: number;
  /** For an album, book or comic issue search: whether the release names the sub-item, and why not (N18). */
  nameOk: boolean;
  nameReason: string | null;
  /** For a target that already has a file: whether this release would replace it ("yes" / "no"), by the rules of
   * upgradeRules.ts (quality below the cutoff, a later revision, a format-score gain). Null when there is no file. */
  upgrade: "yes" | "no" | null;
  /** PROPER / REPACK / v2 and the like, as the parser reads it. */
  revisionLabel: string | null;
  /** Other indexers that also carry what looks like this exact same release (same normalized
   * title + exact size) — collapsed into the best-ranked copy instead of showing N separate rows
   * for what's really one release someone happened to post to multiple trackers. */
  alsoOnIndexers?: string[];
  /** The same release on the other indexers, so a grab can fall back to one when the first cannot serve it. */
  alternates?: { indexerId: number | null; indexerName: string; downloadUrl: string; infoHash: string | null }[];
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
    // The protocol is part of the key: an NZB is no fallback for a torrent of the same name and size.
    const key = r.size > 0 ? `${r.protocol}::${normalizeForDedup(r.title)}::${r.size}` : `${r.protocol}::${normalizeForDedup(r.title)}::0::${r.downloadUrl}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, r);
      order.push(key);
    } else if (r.indexerName && r.indexerName !== existing.indexerName) {
      (existing.alsoOnIndexers ??= []).push(r.indexerName);
      if (r.downloadUrl) {
        (existing.alternates ??= []).push({ indexerId: r.indexerId ?? null, indexerName: r.indexerName, downloadUrl: r.downloadUrl, infoHash: r.infoHash ?? null });
      }
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
    // The admin leaving the page ends the search: no further indexers or query forms are asked. Listening from
    // the first line, so a request dropped while the target is still being read is noticed too.
    const aborter = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) aborter.abort();
    });
    const itemRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(req.params.mediaItemId);
    if (!itemRow) throw new HttpError(404, "Media item not found");
    const item = mediaItemFromRow(itemRow);

    let plan: SearchPlan;
    // What Soulseek is asked: the metadata titles as they are, not the scene-cleaned query the indexers get.
    let slskdQuery = item.year ? `${item.title} ${item.year}` : item.title;
    let targetSeason: number | null = null;
    let targetEpisode: number | null = null;
    let targetSceneSeason: number | null = null;
    let targetSceneEpisode: number | null = null;
    let targetAbsoluteEpisode: number | null = null;
    let targetSceneIndex: SceneIndex | undefined;
    let targetAirDate: string | null = null;
    /** The other plans a season search runs: a scene may have split one aired season into several. */
    const furtherPlans: SearchPlan[] = [];
    let sceneSeasons: Set<number> | null = null;
    let subName: TargetName | null = null;

    const episodeId = req.query.episodeId as string | undefined;
    const subItemId = req.query.subItemId as string | undefined;
    const seasonNumberParam = req.query.seasonNumber as string | undefined;

    if (episodeId) {
      const ep = (await db.prepare("SELECT * FROM episodes WHERE id = ?").get(episodeId)) as any;
      if (!ep) throw new HttpError(404, "Episode not found");
      // The same query, typed search and target an automatic search of this episode makes: the
      // scene-numbered (TheXEM) query where the show has one, a daily show's date, an anime's
      // absolute number.
      plan = await episodePlanFor(item, ep);
      targetSeason = ep.season_number;
      targetEpisode = ep.episode_number;
      targetSceneSeason = ep.scene_season_number;
      targetSceneEpisode = ep.scene_episode_number;
      targetSceneIndex = await sceneIndexFor(item.id);
      if (plan.target && "airDate" in plan.target) targetAirDate = plan.target.airDate;
      else if (plan.target) targetAbsoluteEpisode = plan.target.absoluteEpisode ?? null;
      slskdQuery = plan.query;
    } else if (seasonNumberParam) {
      // Season-only (no specific episode) — surfaces full-season pack releases, which a
      // per-episode query wouldn't reliably match against.
      targetSeason = Number(seasonNumberParam);
      // Every season number a release may call this season by: the scene's (TheXEM) where the show has one.
      const rows = (await db
        .prepare("SELECT DISTINCT scene_season_number FROM episodes WHERE media_item_id = ? AND season_number = ?")
        .all(item.id, targetSeason)) as { scene_season_number: number | null }[];
      // Sorted here, not by the database (which puts NULL first or last by driver): the lowest is the main query.
      const scenes = Array.from(new Set(rows.map((r) => (r.scene_season_number == null ? targetSeason! : Number(r.scene_season_number))))).sort((a, b) => a - b);
      if (scenes.length === 0) scenes.push(targetSeason);
      sceneSeasons = new Set([targetSeason, ...scenes]);
      plan = await seasonPlanFor(item, scenes[0]);
      for (const scene of scenes.slice(1)) furtherPlans.push(await seasonPlanFor(item, scene));
      slskdQuery = plan.query;
    } else if (subItemId) {
      const sub = (await db.prepare("SELECT * FROM sub_items WHERE id = ?").get(subItemId)) as any;
      if (!sub) throw new HttpError(404, "Sub-item not found");
      plan = subItemPlanFor(item, sub);
      slskdQuery = `${item.title} ${sub.title}`;
      subName = { title: editionlessTitle(sub.title), parentTitle: item.title, siblingTitles: await siblingTitlesOf(item, sub.id), ...(await yearFieldsOf(item, sub)) };
    } else {
      // Only meaningful for the plain whole-item search (no episode/season/sub-item target) — an
      // episodic/collection search already confirms identity via season/episode/sub-item title
      // matching instead. See scheduler.ts's chooseBestResult/matchTierFor for how the ids are used:
      // a preference among already-viable results, never a filter.
      plan = await singlePlanFor(item);
      // An artist's discography is not found by its name alone among everything else of the artist's.
      if (item.type === "artist" && discographyGrabsEnabled()) furtherPlans.push(await discographyPlanFor(item));
    }
    const query = plan.query;

    const indexers = ((await db.prepare("SELECT * FROM indexers WHERE enabled = 1").all()) as any[]).map(
      indexerFromRow
    );
    if (aborter.signal.aborted) return;
    const outcomes = new Map<number, IndexerSearchOutcome>();
    const noteOutcome = (o: IndexerSearchOutcome) => {
      const known = outcomes.get(o.indexerId);
      if (!known) outcomes.set(o.indexerId, { ...o });
      else if (!o.ok) {
        known.ok = false;
        known.error = o.error;
      }
    };
    const hintsOf = (p: SearchPlan) => ({ ...searchHintsOf(p, item.id), onOutcome: noteOutcome, signal: aborter.signal });
    const rawResults = await searchAllIndexers(indexers as any, query, item.type as any, true, plan.ids, hintsOf(plan));
    if (furtherPlans.length > 0) {
      // The queries of a season a scene splits overlap (a pack named by both): a release is listed once.
      const seen = new Set(rawResults.map((r) => `${r.indexerId ?? r.indexerName}:${r.downloadUrl || `${r.title}:${r.size}`}`));
      for (const further of furtherPlans) {
        if (aborter.signal.aborted) break;
        for (const r of await searchAllIndexers(indexers as any, further.query, item.type as any, true, further.ids, hintsOf(further))) {
          const key = `${r.indexerId ?? r.indexerName}:${r.downloadUrl || `${r.title}:${r.size}`}`;
          if (seen.has(key)) continue;
          seen.add(key);
          rawResults.push(r);
        }
      }
    }

    if (aborter.signal.aborted) return;

    // Soulseek has no Torznab-style indexer — a configured, enabled slskd client is queried
    // directly instead and its results merged in alongside the indexer ones. Music-shaped
    // libraries only, since (user, filename) results from Soulseek only make sense there.
    if (item.type === "artist") {
      const slskdClients = ((await db.prepare("SELECT * FROM download_clients WHERE type = 'slskd' AND enabled = 1").all()) as any[]).map(
        downloadClientFromRow
      );
      for (const client of slskdClients) {
        try {
          rawResults.push(...(await searchSlskd(client as any, slskdQuery)));
        } catch (err) {
          log.warn(`[search] slskd client "${client.name}" search failed:`, (err as Error).message);
        }
      }
    }

    let allowedQualities: string[] = [];
    let cutoff = "";
    let minFormatScore = 0;
    let qualityGroups: string[][] = [];
    let wantedLanguage: string | null = null;
    if (item.qualityProfileId) {
      const profileRow = await db.prepare("SELECT * FROM quality_profiles WHERE id = ?").get(item.qualityProfileId);
      if (profileRow) {
        const profile = qualityProfileFromRow(profileRow);
        allowedQualities = profile.allowedQualities;
        cutoff = profile.cutoff;
        minFormatScore = profile.minFormatScore ?? 0;
        qualityGroups = profile.qualityGroups ?? [];
        wantedLanguage = profile.language ?? null;
      }
    }

    const blocklisted = await getBlocklistedTitles(item.id);
    const titleTags = await tagIdsOfItem(item.id);
    // Same auto-grab rules as chooseBestResult: a type with no quality tiers (music, books, ...)
    // takes any quality, and a size of 0 means the indexer didn't report one.
    const tiered = usesQualityTiers(item.type);
    // The item's identity (year + ids) for whole-item and episode/season searches alike: the
    // identity gate below compares every release's title and year against it, and matchTierFor
    // prefers an id/year-confirmed release among the viable ones. A sub-item (album/book) search
    // confirms identity by the sub-item's own title instead, so identity stays null there.
    const identity: TargetIdentity | null = !subItemId ? targetIdentityOf(item) : null;
    const identityTarget = tiered && identity ? { type: item.type, title: item.title, year: identity.year, externalIds: identity.externalIds, aliases: await aliasTitlesFor(item.id), ...(await identityContextFor(item.id)) } : null;
    // What an automatic search of this target would grab, by the same decision code: the admin's own
    // search is not delayed, and the file the target already has is only replaced by a real upgrade.
    const delayProfile = pickDelayProfile(await loadDelayProfiles(), await tagIdsForMediaItem(item.id));
    const clients = await rowsToDownloadClients();
    const hasAutoPick = !seasonNumberParam && !subItemId && (!!plan.target || getMediaTypeConfig(item.type).shape === "single");
    // The file the target already has and the profile's upgrade rules: what an automatic search replaces
    // only by a real upgrade, and the "would replace it" label.
    const existingForUpgrade =
      tiered && !seasonNumberParam && !subItemId
        ? await existingFileRecord(item, episodeId ? Number(episodeId) : null, null)
        : null;
    const upgradeProfile = existingForUpgrade ? upgradeProfileOf(item.qualityProfileId ? await getQualityProfile(item.qualityProfileId) : null) : null;
    const onDisk = hasAutoPick ? await existingFileQuality(item, episodeId ? Number(episodeId) : null, null) : undefined;
    // The season pack guards of an automatic search of this target (a pack the automatic search would
    // skip is not offered as its pick).
    const packContext = packContextFor(item, plan);
    let autoPick: SearchResult | null = null;
    if (hasAutoPick && rawResults.length > 0) {
      autoPick =
        (
          await chooseBestResult(
            rawResults,
            allowedQualities,
            cutoff,
            item.qualityProfileId,
            minFormatScore,
            plan.target ?? null,
            blocklisted,
            item.type,
            delayProfile,
            identity,
            item.id,
            {
              clients,
              upgradeFromRank: onDisk === undefined ? null : qualityRank(onDisk),
              existing: existingForUpgrade && upgradeProfile ? { file: existingForUpgrade, profile: upgradeProfile } : undefined,
              name: { title: item.title },
              indexers,
              userInvoked: true,
              label: item.title,
              pack: packContext,
            }
          )
        )?.result ?? null;
    }
    const runtimeContext = await runtimeContextFor(item.id, item.type);
    const revisionMode = propersMode();
    // What a type with no quality tiers is matched by: the sub-item's names, or (a ROM) the item's own title, as the automatic search does.
    const nameTarget: TargetName | null = tiered ? null : subName ?? (hasAutoPick ? { title: item.title } : null);
    // An artist's albums, for the discographies among the results: what each covers and what of that is missing.
    const artistAlbums: DiscographyAlbum[] = item.type === "artist" ? await discographyAlbumsOf(item.id) : [];
    const discographyOn = discographyGrabsEnabled();
    const discographyFacts = (title: string, parsed: ReturnType<typeof parseReleaseTitle>) => {
      if (item.type !== "artist" || !parsed.discography) return null;
      const covered = albumsCoveredBy(parsed.discography, artistAlbums);
      const missing = covered.filter((album) => isWantedAlbum(album, (date) => isNotYetReleased(date)));
      return { covered, missing, namesArtist: releaseNamesArtist(title, item.title) };
    };
    const nameFields = (title: string) => {
      // A discography names no single album; it fits an album search when it is the artist's and covers the album.
      const parsed = parseReleaseTitle(title);
      const facts = nameTarget && subItemId ? discographyFacts(title, parsed) : null;
      if (facts) {
        const covers = facts.covered.some((album) => album.id === Number(subItemId));
        const ok = discographyOn && facts.namesArtist && covers;
        const reason = ok
          ? null
          : !discographyOn
          ? "Discography grabs are turned off"
          : !facts.namesArtist
          ? "It is another artist's discography"
          : "The years it spans do not include this album";
        return { nameOk: ok, nameReason: reason };
      }
      const verdict = nameTarget ? releaseNameVerdict(title, nameTarget, item.type) : { ok: true, reason: null };
      return { nameOk: verdict.ok, nameReason: verdict.reason };
    };

    // What the checks of an automatic search need, read once for the whole list.
    const minimumSeedersById = new Map(indexers.map((i: any) => [i.id as number, (i.minimumSeeders ?? 0) as number]));
    const freeBytes = freeSpaceCheckEnabled() ? await freeBytesForItem(item.id) : null;
    const reserveBytes = freeSpaceReserveBytes();
    const identityEnforced = identityModeFor(item.type) === "enforce";
    const episodic = getMediaTypeConfig(item.type).shape === "episodic";
    // Parsed as the automatic search parses: a release that names a cour by its own title is that season's episode.
    const aliasSeasons = tiered ? await aliasSeasonsFor(item.id) : new Map<string, number>();
    const aliasSeasonCounts = aliasSeasons.size > 0 ? await seasonEpisodeCounts(item.id) : undefined;
    const parsedByResult = new Map<SearchResult, ReturnType<typeof parseReleaseTitle>>(
      rawResults.map((r) => [r, applyAliasSeason(parseReleaseTitle(r.title), aliasSeasons, aliasSeasonCounts)])
    );
    let packEpisodes: PackEpisode[] | null = null;
    if (packContext && rawResults.some((r) => parsedByResult.get(r)?.isFullSeason)) {
      packEpisodes = typeof packContext.episodes === "function" ? await packContext.episodes() : packContext.episodes;
    }
    const packRules = packSettings();
    const packUpgradeProfile = upgradeProfileOf(item.qualityProfileId ? await getQualityProfile(item.qualityProfileId) : null);
    const targetLabel =
      targetAirDate !== null
        ? `the air date ${targetAirDate}`
        : targetSeason !== null && targetEpisode !== null
          ? `S${String(targetSeason).padStart(2, "0")}E${String(targetEpisode).padStart(2, "0")}`
          : targetSeason !== null
            ? `season ${targetSeason}`
            : null;
    const now = Date.now();
    const annotated: AnnotatedSearchResult[] = await Promise.all(rawResults.map(async (r) => {
      const parsed = parsedByResult.get(r)!;
      const matchesTarget =
        targetAirDate !== null
          ? releaseMatchesAirDate(parsed, targetAirDate) ||
            (targetSeason !== null && targetEpisode !== null && releaseMatchesEpisode(parsed, targetSeason, targetEpisode, targetSceneSeason, targetSceneEpisode, null, targetSceneIndex))
          : targetSeason !== null && targetEpisode !== null
            ? releaseMatchesEpisode(parsed, targetSeason, targetEpisode, targetSceneSeason, targetSceneEpisode, targetAbsoluteEpisode, targetSceneIndex)
            : targetSeason !== null
              ? sceneSeasons
                ? parsed.seasonNumber != null && sceneSeasons.has(parsed.seasonNumber)
                : parsed.seasonNumber === targetSeason
              : true;
      const verdict = identityTarget ? releaseIdentifiesTarget(r, parsed, identityTarget) : null;
      const size = knownReleaseSize(r.size);
      // The same refusals an automatic grab applies (multi-season packs, split seasons, disc images,
      // samples, burned-in subtitles); the user may still pick the release by hand.
      const refusal = releaseRejection(parsed, { title: r.title, size }, item.type);
      const { totalScore, matches, rejected: formatRejected, rejectReason: formatRejectReason } = await scoreRelease(
        r.title,
        size,
        item.qualityProfileId,
        item.type,
        indexerInfoOf(r),
        item.id,
        r.indexerId ?? null
      );
      const isBlocklisted = isBlockedRelease(blocklisted, r);
      const sizeAllowed = !tiered || sizeWithinQualityBounds(parsed.quality, size, runtimeContext ? releaseRuntimeMinutes(parsed, runtimeContext) : null);
      const upgradeVerdict =
        existingForUpgrade && upgradeProfile
          ? judgeUpgrade(upgradeProfile, revisionMode, existingForUpgrade, { quality: parsed.quality, title: r.title, score: totalScore })
          : null;

      // Every reason an automatic search of this target would not take the release, from the same checks.
      const facts = emptyFacts();
      facts.hashName = parsed.rejected;
      facts.blocklisted = isBlocklisted;
      // With no client at all every release would say so; that is `downloadAllowed`, not a reason per release.
      // A client waiting out a back-off is still a client: the admin can try it by hand.
      const clientForProtocol = pickClientForProtocol(clients, r.protocol, { itemTags: titleTags, ignoreBackoff: true });
      facts.noClientFor = clients.length > 0 && clientForProtocol === null ? r.protocol : null;
      facts.refusal = refusal;
      facts.availability = availabilityRejectionDetail(r, minimumSeedersById, now);
      facts.freeSpace = freeSpaceReason(size, freeBytes, reserveBytes);
      facts.wrongTarget = !matchesTarget && targetLabel ? `It is not for ${targetLabel}` : null;
      if (packContext && packEpisodes && parsed.isFullSeason) {
        const packVerdict = judgeSeasonPack({
          parsed,
          season: parsed.seasonNumber ?? packContext.season,
          episodes: packEpisodes,
          item: packContext.item,
          packQuality: parsed.quality,
          cutoff,
          qualityGroups,
          settings: packRules,
          upgrade: {
            profile: packUpgradeProfile,
            mode: revisionMode,
            packTitle: r.title,
            packScore: packUpgradeProfile.cutoffFormatScore > 0 ? totalScore : undefined,
          },
        });
        facts.pack = packVerdict.ok ? null : packVerdict.reason;
      }
      const names = nameFields(r.title);
      facts.name = names.nameOk ? null : names.nameReason ?? "Its title does not match";
      // A discography is judged as the automatic search judges it (services/discography.ts), the minimum of missing albums aside.
      const discographyInfo = discographyFacts(r.title, parsed);
      if (discographyInfo) {
        if (!discographyOn) facts.pack = "Discography grabs are turned off";
        else if (!discographyInfo.namesArtist) facts.name = facts.name ?? "It is another artist's discography";
        else {
          const judged = judgeDiscography(r.title, artistAlbums, { minWanted: 1, isUnreleased: (date) => isNotYetReleased(date) });
          if (!judged.ok) facts.pack = judged.reason;
        }
      }
      facts.identity = verdict && !verdict.ok && identityEnforced ? verdict.detail : null;
      facts.quality = tiered && allowedQualities.length > 0 && !allowedQualities.includes(parsed.quality) ? `Quality "${parsed.quality}" isn't allowed by this quality profile` : null;
      if (upgradeVerdict === "no") facts.notAnUpgrade = "It isn't an upgrade over the file already on disk";
      else if (!existingForUpgrade && onDisk !== undefined && groupedRank(parsed.quality, qualityGroups) <= groupedRank(onDisk, qualityGroups)) {
        facts.notAnUpgrade = `Quality "${parsed.quality}" isn't an upgrade over what's already on disk`;
      }
      facts.size = sizeAllowed ? null : "Its size doesn't fit this quality's configured size range";
      facts.language = tiered ? languageRejection(wantedLanguage, parsed.languages) : null;
      if (delayProfile && ((r.protocol === "torrent" && !delayProfile.enableTorrent) || (r.protocol === "usenet" && !delayProfile.enableUsenet))) {
        facts.protocolOff = `Its protocol (${r.protocol}) is turned off in the delay profile`;
      }
      facts.formatRejected = formatRejected ? formatRejectReason ?? "A custom format the profile rejects matches it" : null;
      // The engine ignores the minimum for a type with no quality tiers (music, books, comics).
      facts.belowMinimumScore = tiered && !formatRejected && totalScore < minFormatScore ? `Its custom-format score (${totalScore}) is below the profile's minimum (${minFormatScore})` : null;
      const rejections = buildRejections(facts);
      const summary = summarize(rejections);
      const firstPermanent = rejections.find((x) => x.type === "permanent") ?? rejections[0];

      return {
        ...r,
        parsedQuality: parsed.quality,
        matchesTarget,
        allowedByProfile: !tiered || allowedQualities.length === 0 || allowedQualities.includes(parsed.quality),
        sizeAllowed,
        formatScore: totalScore,
        formatMatches: matches.map((m) => m.name),
        matchTier: matchTierFor(r, identity),
        identityOk: verdict ? verdict.ok : true,
        identityMatch: verdict?.matchType ?? null,
        identityReason: verdict && !verdict.ok ? verdict.detail : null,
        identityRejection: verdict && !verdict.ok ? verdict.reason : null,
        parsedTitle: parsed.title,
        blocklisted: isBlocklisted,
        wouldAutoGrab: autoPick === r,
        ...names,
        upgrade: upgradeVerdict === null ? null : upgradeVerdict === "yes" ? "yes" : "no",
        revisionLabel: revisionLabelOf(parsed.revision),
        rejected: summary.rejected,
        rejectReason: firstPermanent?.reason,
        rejections,
        approved: summary.approved,
        temporarilyRejected: summary.temporarilyRejected,
        downloadAllowed: clientForProtocol !== null,
        ageMinutes: ageMinutesOf(r.publishDate, now),
        releaseGroup: parsed.releaseGroup,
        languages: parsed.languages,
        releaseType: releaseTypeOf(parsed, episodic),
        episodesCovered:
          packContext && packEpisodes && parsed.isFullSeason ? episodesCoveredBy(parsed, parsed.seasonNumber ?? packContext.season, packEpisodes).length : null,
        discography: discographyInfo ? { albumsCovered: discographyInfo.covered.length, albumsMissing: discographyInfo.missing.length } : null,
        qualityRank: tiered ? qualityRank(parsed.quality) : -1,
        flags: indexerFlagsOf(r),
        serverRank: 0,
      };
    }));

    // Previously returned in whatever order the indexer itself gave back — an indexer's own
    // relevance ranking has no idea what "matches this specific season/episode" or "meets this
    // profile" mean, so an unrelated show whose title happens to share a word (or a wrong-season
    // episode of the right show) could easily outrank the actual target. Sort by the same signals
    // an automatic grab already weighs — real match first, then profile-allowed, not blocklisted,
    // format score, then seeders — so the top of the list is what auto-search would actually pick,
    // not just whatever the indexer happened to return first.
    const priorityById = new Map(indexers.map((i: any) => [i.id, i.priority]));
    const priorityOf = (r: SearchResult) => priorityById.get(r.indexerId ?? -1) ?? 25;
    const preferredProtocol = delayProfile?.preferredProtocol ?? "none";
    annotated.sort(
      (a, b) =>
        Number(b.matchesTarget) - Number(a.matchesTarget) ||
        Number(b.identityOk) - Number(a.identityOk) ||
        Number(b.nameOk) - Number(a.nameOk) ||
        Number(b.allowedByProfile) - Number(a.allowedByProfile) ||
        Number(a.rejected) - Number(b.rejected) ||
        Number(a.blocklisted) - Number(b.blocklisted) ||
        Number(b.wouldAutoGrab) - Number(a.wouldAutoGrab) ||
        (tiered ? qualityRank(b.parsedQuality) - qualityRank(a.parsedQuality) : 0) ||
        b.formatScore - a.formatScore ||
        b.matchTier - a.matchTier ||
        protocolPreferenceKey(preferredProtocol, b.protocol) - protocolPreferenceKey(preferredProtocol, a.protocol) ||
        priorityOf(a) - priorityOf(b) ||
        protocolGroup(a.protocol) - protocolGroup(b.protocol) ||
        comparePeers(a, b) ||
        compareUsenetAge(a, b) ||
        (a.protocol === "torrent" && b.protocol === "torrent" ? (b.seeders ?? 0) - (a.seeders ?? 0) : 0)
    );

    const listed = dedupeResults(annotated);
    listed.forEach((r, index) => {
      r.serverRank = index + 1;
    });
    // `?detail=1` also says which indexers answered (a failed one otherwise looks like "nothing exists").
    if (req.query.detail === "1") {
      const counts = new Map<number, number>();
      for (const r of rawResults) if (r.indexerId != null) counts.set(r.indexerId, (counts.get(r.indexerId) ?? 0) + 1);
      res.json({
        results: listed,
        // Only the indexers this search applied to: one that takes no release of this type was never asked.
        indexers: indexers.filter((i: any) => String(i.mediaTypes).split(",").includes(item.type)).map((i: any) => {
          const outcome = outcomes.get(i.id);
          return { id: i.id, name: i.name, ok: outcome ? outcome.ok : true, count: counts.get(i.id) ?? 0, ...(outcome?.error ? { error: outcome.error } : {}) };
        }),
      });
      return;
    }
    res.json(listed);
  })
);

/**
 * The admin picks a release by hand (a search result, or a release the delay profile is holding): the checks
 * a manual grab makes, then the same grab() every automatic path uses. Throws an HttpError for a refusal.
 */
export async function manualGrab(mediaItemId: number | string, b: Record<string, any>) {
  {
    const itemRow = await db.prepare("SELECT * FROM media_items WHERE id = ?").get(mediaItemId);
    if (!itemRow) throw new HttpError(404, "Media item not found");
    const item = mediaItemFromRow(itemRow);

    if (!b.downloadUrl) throw new HttpError(400, "downloadUrl is required");
    // An id from the request that is not an indexer, episode or sub-item here would fail the queue row's foreign
    // key after the client had taken the download: a held release can be days old.
    const knownIndexers = new Set(
      ((await db.prepare("SELECT id FROM indexers").all()) as { id: number }[]).map((row) => Number(row.id))
    );
    const knownIndexerId = (id: unknown): number | null => (id != null && knownIndexers.has(Number(id)) ? Number(id) : null);
    if (b.episodeId && !(await db.prepare("SELECT 1 FROM episodes WHERE id = ? AND media_item_id = ?").get(b.episodeId, item.id))) {
      throw new HttpError(404, "Episode not found");
    }
    if (b.subItemId && !(await db.prepare("SELECT 1 FROM sub_items WHERE id = ? AND media_item_id = ?").get(b.subItemId, item.id))) {
      throw new HttpError(404, "Sub-item not found");
    }
    const protocolOf = (value: unknown) => (value === "usenet" || value === "torrent" || value === "http" || value === "slskd" ? value : undefined);
    const blocklistedCopy = (copy: { indexerId: unknown; infoHash: unknown }) =>
      b.title
        ? isBlocklisted(Number(mediaItemId), {
            title: b.title,
            protocol: protocolOf(b.protocol),
            indexerId: copy.indexerId == null ? null : Number(copy.indexerId),
            size: Number(b.size) || 0,
            publishDate: typeof b.publishDate === "string" ? b.publishDate : null,
            infoHash: typeof copy.infoHash === "string" ? copy.infoHash : null,
          })
        : Promise.resolve(false);
    // What the admin overrode on purpose: the history records a grab as forced only for these.
    const overrides: string[] = Array.isArray(b.overrides) ? b.overrides.filter((c: unknown): c is string => typeof c === "string").slice(0, 20) : [];
    let forced = overrides.length > 0;
    // `force` overrides every refusal below (the 409 confirm flow); `overrides` names the rejections the admin read in the list and accepted.
    const mayOverride = (code: string) => !!b.force || overrides.includes(code);
    // A blocklisted release is an ordinary rejection: "grab anyway" overrides it, as in Sonarr.
    if (await blocklistedCopy({ indexerId: b.indexerId ?? null, infoHash: b.infoHash })) {
      if (!mayOverride("blocklisted")) throw new HttpError(409, "This release is blocklisted for this media item. Grab it anyway to override the blocklist.", "override");
      forced = true;
    }

    // A manual grab records how the release matched like an automatic grab's (grab_source tells
    // the two apart). While the type's gate enforces, a release the gate would reject is refused
    // once with the reason (409) so the admin can confirm; `force: true` grabs it anyway. The
    // verdict is settled before the download client is touched, so a refused grab leaves nothing
    // in the client and the confirmed retry adds the release exactly once.
    const parsedTitle = parseReleaseTitle(b.title ?? "");
    // A discography is for every album it covers that is missing, whichever album the search was opened from: it
    // is queued for all of them, and the importer files each album's folder under its own album.
    let discographyTargets: number[] = [];
    if (item.type === "artist" && !b.episodeId && parsedTitle.discography) {
      // An album that already has a download on its way is covered by the release but is not downloaded again.
      const albums = await discographyAlbumsOf(item.id);
      let alreadyDownloading = 0;
      const judgedAgainst: DiscographyAlbum[] = [];
      for (const album of albums) {
        const queued = await isAlreadyQueued(item.id, null, album.id);
        if (queued) alreadyDownloading++;
        judgedAgainst.push(queued ? { ...album, monitored: false } : album);
      }
      const judged = judgeDiscography(String(b.title), judgedAgainst, { minWanted: 1, isUnreleased: (date) => isNotYetReleased(date) });
      // An album with the word in its own title ("Discography: The Complete Singles Collection") is grabbed as that album.
      if (!(!judged.ok && judged.isAlbum)) {
        if (judged.wanted.length === 0) {
          const why = judged.ok ? "It covers no album that is missing" : judged.reason;
          throw new HttpError(400, `${why}${alreadyDownloading > 0 ? " (the albums that are missing are already downloading)" : ""}, so there is nothing to grab it for`);
        }
        if (!judged.ok) {
          // The list sends the code of the rejection it shows, which for a discography is the pack one.
          if (!mayOverride("discography") && !mayOverride("season-pack")) throw new HttpError(409, `${judged.reason}. Grab it anyway to override.`, "override");
          forced = true;
        }
        discographyTargets = judged.wanted.map((album) => album.id);
      }
    }
    const verdict =
      b.title && usesQualityTiers(item.type) && !b.subItemId
        ? releaseIdentifiesTarget(
            { title: b.title, imdbId: b.imdbId ?? null, tmdbId: b.tmdbId ?? null, tvdbId: b.tvdbId ?? null },
            parsedTitle,
            await identityTargetFor(item)
          )
        : null;
    if (verdict && !verdict.ok && identityModeFor(item.type) === "enforce") {
      if (!mayOverride("identity")) throw new HttpError(409, `${verdict.detail}. Grab it anyway, or add the release's title as an alias of this item.`, "override");
      forced = true;
    }

    // Either an explicit client id, or (the UI's normal path) the release's protocol — an NZB
    // handed to qBittorrent, or a torrent to a disabled client, just fails at the client.
    const protocol =
      b.protocol === "usenet" || b.protocol === "torrent" || b.protocol === "http" || b.protocol === "slskd" ? b.protocol : "torrent";
    let clientRow: unknown;
    if (b.downloadClientId) {
      clientRow = await db.prepare("SELECT * FROM download_clients WHERE id = ?").get(b.downloadClientId);
      if (!clientRow) throw new HttpError(404, "Download client not found");
    } else {
      const enabled = ((await db.prepare("SELECT * FROM download_clients WHERE enabled = 1 ORDER BY id").all()) as any[]).map(downloadClientFromRow);
      if (enabled.length === 0) throw new HttpError(400, "Add and enable a download client first");
      // The client the release's indexer names, else one by the title's tags (Sonarr: tagged clients first).
      const viaIndexer = b.indexerId ? ((await db.prepare("SELECT download_client_id FROM indexers WHERE id = ?").get(Number(b.indexerId))) as { download_client_id: number | null } | undefined) : undefined;
      const picked = pickClientForProtocol(enabled as any, protocol, { clientId: viaIndexer?.download_client_id ?? null, itemTags: await tagIdsOfItem(item.id), ignoreBackoff: true });
      if (!picked) throw new HttpError(400, `No enabled download client can handle a "${protocol}" release`);
      clientRow = await db.prepare("SELECT * FROM download_clients WHERE id = ?").get(picked.id);
    }
    const client = downloadClientFromRow(clientRow) as any;

    // The same release already on its way for this target: a double click or a second admin would
    // otherwise send it to the client twice (two NZB downloads, two rows to import).
    const releaseTitle = String(b.title ?? "Unknown release");
    const sameRelease = await db
      .prepare(
        `SELECT id FROM queue WHERE media_item_id = ? AND title = ? AND status IN ('queued', 'downloading', 'completed')
         AND COALESCE(episode_id, 0) = ? AND COALESCE(sub_item_id, 0) = ? LIMIT 1`
      )
      .get(item.id, releaseTitle, Number(b.episodeId) || 0, discographyTargets.length > 0 ? 0 : Number(b.subItemId) || 0);
    // Not overridable by `force` (that overrides rejections): a second copy of what is already on its way helps nobody.
    if (sameRelease) {
      throw new HttpError(409, `"${releaseTitle}" is already in the queue for this item.`, "duplicate");
    }

    // Through the same grab() as the automatic paths: one grab at a time per item, the client's
    // refusal and unavailability told apart, and a download another row already tracks refused. The
    // admin may still add a different release while one is queued (allowCovered).
    const searchResult = {
      ...b,
      // Other indexers' links are for the fallback below; they do not belong on the queue row or in the history.
      alternates: undefined,
      indexerId: knownIndexerId(b.indexerId),
      indexerName: typeof b.indexerName === "string" ? b.indexerName : "",
      title: releaseTitle,
      // NaN, not 0, for an unknown size: grab() stores it as NULL, as the interactive grab always did.
      size: b.size == null || !Number.isFinite(Number(b.size)) ? Number.NaN : Number(b.size),
      seeders: b.seeders ?? null,
      leechers: b.leechers ?? null,
      publishDate: typeof b.publishDate === "string" ? b.publishDate : null,
      downloadUrl: b.downloadUrl,
      protocol,
      category: b.category ?? null,
      infoHash: typeof b.infoHash === "string" ? b.infoHash : null,
    } as SearchResult;
    // A full-season pack grabbed for one episode is recorded against its season too (grab() does it), so
    // the rest of that season counts as queued and the importer places it all.
    const seasonNumber: number | null = b.episodeId ? null : (b.seasonNumber ?? null);
    // The same release on other indexers (the list collapses it into one row): when the first link cannot
    // be served, the next is tried. Only a refusal of the release moves on; an unreachable client does not.
    const alternates = Array.isArray(b.alternates)
      ? (b.alternates as any[])
          .filter((a) => a && typeof a.downloadUrl === "string" && a.downloadUrl)
          .slice(0, 5)
          .map((a) => ({
            indexerId: a.indexerId ?? null,
            indexerName: typeof a.indexerName === "string" ? a.indexerName : "",
            downloadUrl: a.downloadUrl as string,
            infoHash: typeof a.infoHash === "string" ? a.infoHash : null,
          }))
      : [];
    // A copy on another indexer can be a different torrent, and a blocklist entry is per hash and per indexer:
    // each is asked, and a blocklisted one is only tried when the admin forced the grab.
    const usableAlternates: typeof alternates = [];
    for (const a of alternates) {
      if (!mayOverride("blocklisted") && (await blocklistedCopy(a))) continue;
      usableAlternates.push(a);
    }
    const attempts = [searchResult, ...usableAlternates.map((a) => ({ ...searchResult, ...a, indexerId: knownIndexerId(a.indexerId) }))];
    let grabbed = false;
    for (const attempt of attempts) {
      try {
        grabbed = await grabRelease(
          client,
          item,
          b.episodeId ?? null,
          discographyTargets.length > 0 ? null : b.subItemId ?? null,
          { result: attempt, quality: parsedTitle.quality, identity: verdict },
          0,
          seasonNumber,
          "interactive",
          { allowCovered: true, refuseSameRelease: true, forced, ...(discographyTargets.length > 0 ? { targetSubItemIds: discographyTargets } : {}) }
        );
        break;
      } catch (err) {
        if (err instanceof ReleaseRefusedError && attempt !== attempts[attempts.length - 1]) continue;
        // The messages quote the indexer's or client's own words, which can carry a URL with an API key.
        const withoutUrls = (message: string) => message.replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|magnet:\?)\S*/gi, "<link>");
        if (err instanceof DuplicateGrabError) throw new HttpError(409, err.message, "duplicate");
        if (err instanceof ReleaseRefusedError) throw new HttpError(502, `This release could not be added: ${withoutUrls(err.message)}`);
        if (err instanceof DownloadClientUnavailableError) throw new HttpError(503, withoutUrls(err.message));
        throw err;
      }
    }
    if (!grabbed) throw new HttpError(409, "The download client already has this download for another entry.", "duplicate");

    const queueRow = await db
      .prepare("SELECT * FROM queue WHERE media_item_id = ? AND title = ? AND download_client_id = ? ORDER BY id DESC LIMIT 1")
      .get(item.id, releaseTitle, client.id);
    return queueItemFromRow(queueRow);
  }
}

/** Manual grab: POST /api/search/:mediaItemId/grab */
searchRouter.post(
  "/:mediaItemId/grab",
  asyncHandler(async (req, res) => {
    res.status(201).json(await manualGrab(req.params.mediaItemId, req.body ?? {}));
  })
);
