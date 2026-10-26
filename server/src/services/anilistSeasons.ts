import { db } from "../db/index.js";
import { log } from "./logger.js";
import { finishBackgroundJob, incrementBackgroundJobDone, isBackgroundJobRunning, startBackgroundJob } from "./backgroundJobs.js";

/**
 * Which season of its show an AniList anime is, and where its episode numbers start.
 *
 * AniList lists every season or cour of a show as its own entry, and its episode list is always
 * "episode 1..N". A release names the same episode by its season ("Show S2 - 05") or by the show's running
 * absolute number ("Show - 29"), neither of which is the entry's own row (season 1, episode 5). Sonarr has no
 * such problem, because TVDB numbers every season under one series. Here the entry's place is read from
 * AniList's PREQUEL relations: the number of earlier TV seasons (its ordinal) and the episodes they hold (its
 * absolute offset). Written onto the entry's rows as scene numbers (season = ordinal) and absolute numbers
 * (offset + episode), the existing matching, which prefers scene numbers and absolute numbers, does the rest.
 *
 * Only a show whose rows came from AniList is numbered this way: with a TMDB or TVDB id its rows are those
 * providers', which number a show's seasons themselves.
 */

export const ANILIST_SEASON_KEY = "anilistSeason";
/** Entry formats that are a season of their own: a movie, OVA or special between two seasons is walked
 * through but not counted. */
const SEASON_FORMATS = new Set(["TV", "TV_SHORT", "ONA"]);
const MAX_PREQUEL_HOPS = 15;
const ANILIST_URL = "https://graphql.anilist.co";

export interface AnilistSeasonContext {
  /** 1 for the first season; the count of earlier seasons plus one. */
  ordinal: number;
  /** The episodes the earlier seasons hold: the absolute number of this entry's episode 0. */
  offset: number;
  /** False when an earlier season's episode count is unknown, so the offset is a lower bound. */
  complete: boolean;
  checkedAt: string;
}

const RELATIONS_QUERY = `query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    relations { edges { relationType(version: 2) node { id type format episodes } } }
  }
}`;

async function relationsOf(anilistId: number): Promise<{ edges: any[] }> {
  const res = await fetch(ANILIST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: RELATIONS_QUERY, variables: { id: anilistId } }),
  });
  if (!res.ok) throw new Error(`AniList relations lookup failed: HTTP ${res.status}`);
  const body: any = await res.json();
  if (!body?.data?.Media) throw new Error(`AniList has no record of ${anilistId}`);
  return { edges: body.data.Media.relations?.edges ?? [] };
}

/** Walks an entry's PREQUEL chain: how many seasons come before it and how many episodes they hold. Throws when
 * AniList can't be asked; says nothing then, so a caller keeps what it had. */
export async function fetchAnilistSeasonContext(anilistId: string): Promise<Omit<AnilistSeasonContext, "checkedAt">> {
  let current = Number(anilistId);
  if (!Number.isInteger(current) || current <= 0) throw new Error(`"${anilistId}" is no AniList id`);
  const seen = new Set<number>([current]);
  let ordinal = 1;
  let offset = 0;
  let complete = true;
  for (let hop = 0; hop < MAX_PREQUEL_HOPS; hop++) {
    const { edges } = await relationsOf(current);
    const prequels = edges
      .filter((e) => e?.relationType === "PREQUEL" && e.node?.type === "ANIME" && Number.isInteger(e.node.id) && !seen.has(e.node.id))
      // The season before, not the movie or recap in between, when an entry has both.
      .sort((a, b) => Number(SEASON_FORMATS.has(b.node.format)) - Number(SEASON_FORMATS.has(a.node.format)));
    const prequel = prequels[0]?.node;
    if (!prequel) break;
    seen.add(prequel.id);
    if (SEASON_FORMATS.has(prequel.format)) {
      ordinal++;
      if (typeof prequel.episodes === "number" && prequel.episodes > 0) offset += prequel.episodes;
      else complete = false;
    }
    current = prequel.id;
  }
  return { ordinal, offset, complete };
}

/** The stored context out of an item's extra_metadata, or null when none was read. */
export function seasonContextOf(extraMetadata: string | Record<string, unknown> | null | undefined): AnilistSeasonContext | null {
  try {
    const extra = typeof extraMetadata === "string" ? JSON.parse(extraMetadata) : extraMetadata;
    const value = extra?.[ANILIST_SEASON_KEY] as Partial<AnilistSeasonContext> | undefined;
    if (!value || !Number.isInteger(value.ordinal) || (value.ordinal as number) < 1 || !Number.isInteger(value.offset) || (value.offset as number) < 0) return null;
    return { ordinal: value.ordinal as number, offset: value.offset as number, complete: value.complete !== false, checkedAt: String(value.checkedAt ?? "") };
  } catch {
    return null;
  }
}

function idsOf(raw: string | null): Record<string, string> {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Rows of an entry are AniList's only when no other provider has an id for it (the episode list comes from
 * the first provider that has one: TMDB, TVDB, ..., AniList). */
export function hasAnilistNumberedRows(externalIds: Record<string, string>): boolean {
  return !!externalIds.anilist && !externalIds.tmdb && !externalIds.tvdb;
}

/**
 * Writes the stored context onto the entry's episode rows: scene season = ordinal and scene episode = the row's
 * own number (a sequel only; the first season needs none), and absolute number = offset + episode when the
 * offset is complete. Cheap and offline, so every path that adds rows can call it. Returns the rows it
 * changed.
 */
export async function applyAnilistSeasonToEpisodes(mediaItemId: number): Promise<number> {
  const item = (await db.prepare("SELECT external_ids, extra_metadata FROM media_items WHERE id = ?").get(mediaItemId)) as
    | { external_ids: string | null; extra_metadata: string | null }
    | undefined;
  if (!item || !hasAnilistNumberedRows(idsOf(item.external_ids))) return 0;
  const context = seasonContextOf(item.extra_metadata);
  if (!context) return 0;
  let changed = 0;
  if (context.ordinal > 1) {
    changed += (
      await db
        .prepare(
          `UPDATE episodes SET scene_season_number = ?, scene_episode_number = episode_number
           WHERE media_item_id = ? AND season_number = 1 AND (scene_season_number IS NULL OR scene_season_number <> ? OR scene_episode_number IS NULL OR scene_episode_number <> episode_number)`
        )
        .run(context.ordinal, mediaItemId, context.ordinal)
    ).changes;
  } else {
    // The first season is numbered the way its releases are: nothing of ours is left on the rows.
    changed += (
      await db
        .prepare("UPDATE episodes SET scene_season_number = NULL, scene_episode_number = NULL WHERE media_item_id = ? AND season_number = 1 AND scene_season_number IS NOT NULL")
        .run(mediaItemId)
    ).changes;
  }
  if (context.complete) {
    changed += (
      await db
        .prepare(
          `UPDATE episodes SET absolute_episode_number = episode_number + ?
           WHERE media_item_id = ? AND season_number = 1 AND (absolute_episode_number IS NULL OR absolute_episode_number <> episode_number + ?)`
        )
        .run(context.offset, mediaItemId, context.offset)
    ).changes;
  }
  return changed;
}

/** Writes the context into extra_metadata without erasing what another writer put there while it was being
 * read: the write lands only if the column still holds what was read. */
async function storeContext(mediaItemId: number, context: AnilistSeasonContext): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = (await db.prepare("SELECT extra_metadata FROM media_items WHERE id = ?").get(mediaItemId)) as { extra_metadata: string | null } | undefined;
    if (!row) return;
    let extra: Record<string, unknown> = {};
    try {
      extra = row.extra_metadata ? JSON.parse(row.extra_metadata) : {};
    } catch {
      extra = {};
    }
    extra[ANILIST_SEASON_KEY] = context;
    const result = await db
      .prepare("UPDATE media_items SET extra_metadata = ? WHERE id = ? AND COALESCE(extra_metadata, '') = ?")
      .run(JSON.stringify(extra), mediaItemId, row.extra_metadata ?? "");
    if (result.changes > 0) return;
  }
  log.warn(`[anilistSeasons] item ${mediaItemId} kept changing while its season was being stored`);
}

/** Asks AniList where an anime entry sits in its show, stores it and numbers the entry's rows. Null when the item
 * is no AniList-numbered anime. Throws when AniList can't be asked. */
export async function refreshAnilistSeason(mediaItemId: number): Promise<AnilistSeasonContext | null> {
  const item = (await db.prepare("SELECT type, title, external_ids FROM media_items WHERE id = ?").get(mediaItemId)) as
    | { type: string; title: string; external_ids: string | null }
    | undefined;
  if (!item || item.type !== "anime") return null;
  const ids = idsOf(item.external_ids);
  if (!hasAnilistNumberedRows(ids)) return null;
  const read = await fetchAnilistSeasonContext(ids.anilist);
  const context: AnilistSeasonContext = { ...read, checkedAt: new Date().toISOString() };
  await storeContext(mediaItemId, context);
  const rows = await applyAnilistSeasonToEpisodes(mediaItemId);
  if (context.ordinal > 1 || rows > 0) {
    log.info(`[anilistSeasons] "${item.title}": season ${context.ordinal}, ${context.offset} earlier episode(s)${context.complete ? "" : " (at least)"}; ${rows} row(s) numbered`);
  }
  return context;
}

const ANILIST_PAUSE_MS = 2100;
let backfilling = false;

/** Anime entries whose season has not been read yet. */
async function itemsNeedingSeason(): Promise<{ id: number; title: string }[]> {
  const rows = (await db.prepare("SELECT id, title, external_ids, extra_metadata FROM media_items WHERE type = 'anime' AND external_ids IS NOT NULL").all()) as any[];
  return rows
    .filter((r) => hasAnilistNumberedRows(idsOf(r.external_ids)) && !seasonContextOf(r.extra_metadata))
    .map((r) => ({ id: Number(r.id), title: String(r.title) }));
}

/** Reads the season of every AniList anime that has none, one at a time within AniList's rate limit. Safe to run
 * repeatedly: it visits only entries not read before. */
export async function backfillAnilistSeasons(signal?: AbortSignal): Promise<{ checked: number; failed: number }> {
  if (backfilling || isBackgroundJobRunning("matchProviders", "anilistSeasons")) return { checked: 0, failed: 0 };
  backfilling = true;
  try {
    const items = await itemsNeedingSeason();
    if (items.length === 0) return { checked: 0, failed: 0 };
    const jobId = startBackgroundJob("matchProviders", "anilistSeasons", "Reading anime seasons", items.length);
    let checked = 0;
    let failed = 0;
    let consecutive = 0;
    let error: string | undefined;
    try {
      for (const item of items) {
        if (signal?.aborted) break;
        try {
          await refreshAnilistSeason(item.id);
          checked++;
          consecutive = 0;
        } catch (err) {
          failed++;
          consecutive++;
          log.warn(`[anilistSeasons] "${item.title}": ${(err as Error).message}`);
          // AniList is down or limiting us: the rest wait for the next run.
          if (consecutive >= 3) break;
        }
        incrementBackgroundJobDone("matchProviders", "anilistSeasons");
        await new Promise((resolve) => setTimeout(resolve, ANILIST_PAUSE_MS));
      }
    } catch (err) {
      error = (err as Error).message;
    } finally {
      finishBackgroundJob(jobId, error);
    }
    return { checked, failed };
  } finally {
    backfilling = false;
  }
}
