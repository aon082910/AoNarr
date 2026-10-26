import { db } from "../db/index.js";
import type { MediaItem } from "../types/index.js";
import type { SearchHints } from "./indexerClient.js";
import { alternateTitlesFor } from "./releaseAliases.js";
import { computeAbsoluteEpisodeNumber } from "./importer.js";
import { sceneIndexFor } from "./sceneNumbering.js";
import type { SceneIndex } from "./releaseParser.js";
import {
  absoluteSuffix,
  cleanSceneTitle,
  dailyDateWords,
  episodeSuffix,
  looseTitleVariants,
  seasonSuffix,
  singleItemQuery,
  subItemQuery,
} from "./searchQueries.js";

/** What a release must say to be taken for an episode: its season and episode (the scene's, with the
 * aired numbering as the fallback) or, for a daily show, its air date. */
export type ReleaseTarget =
  | { season: number; episode: number; sceneSeason?: number | null; sceneEpisode?: number | null; absoluteEpisode?: number | null; sceneIndex?: SceneIndex }
  | { airDate: string; season?: number; episode?: number };

/** The season and episode a search query was built from, for a typed tvsearch. */
export interface SearchNumbers {
  season: number;
  episode: number | null;
}

/** Every alternate query a search runs, at most (indexerClient caps the queries that run too). */
const MAX_PLAN_ALTERNATES = 4;

/**
 * One search for one target, the same whichever path asks (automatic, bulk, retry, interactive):
 * the main text query, the other queries to try where it finds nothing, what a typed search asks
 * for, the ids it asks by and what a release must say to be the target.
 */
export interface SearchPlan {
  query: string;
  /** Other titles' queries, tried where the main query found nothing. */
  alternateQueries: string[];
  /** Another form of the search that is asked beside the main one (see SearchHints.alsoQueries). */
  alsoQueries?: string[];
  /** The ids a typed search asks by. A show is asked by its tvdb id alone; the text searches carry none. */
  ids: Record<string, string>;
  hints: Pick<SearchHints, "season" | "episode" | "airDate" | "absolute" | "queryTitle" | "artist" | "album" | "author" | "bookTitle">;
  target: ReleaseTarget | null;
}

export function searchHintsOf(plan: SearchPlan): SearchHints {
  return { ...plan.hints, alternateQueries: plan.alternateQueries, ...(plan.alsoQueries?.length ? { alsoQueries: plan.alsoQueries } : {}) };
}

function parseIds(item: Pick<MediaItem, "externalIds">): Record<string, string> {
  const raw: Record<string, unknown> = item.externalIds ? JSON.parse(item.externalIds) : {};
  const ids: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) if (value != null && value !== "") ids[key] = String(value);
  return ids;
}

/** What a show is asked by on a typed tvsearch: its tvdb id alone, as Sonarr does; with none, the
 * imdb and tmdb ids, for an indexer whose tv-search takes them. */
export function tvSearchIdsOf(item: Pick<MediaItem, "externalIds">): Record<string, string> {
  const ids = parseIds(item);
  if (ids.tvdb) return { tvdb: ids.tvdb };
  const fallback: Record<string, string> = {};
  if (ids.imdb) fallback.imdb = ids.imdb;
  if (ids.tmdb) fallback.tmdb = ids.tmdb;
  return fallback;
}

/** Complete queries, one per other title of the item, each followed by `suffix` (the episode, season
 * or year the main query asks for), then `extra` queries; the main query and repeats are dropped. */
function alternatesFor(main: string, others: string[], extra: string[] = []): string[] {
  const seen = new Set([main.trim().toLowerCase()]);
  const out: string[] = [];
  for (const query of [...extra, ...others]) {
    const key = query.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(query.trim());
    if (out.length >= MAX_PLAN_ALTERNATES) break;
  }
  return out;
}

/** The queries for the item's other names: its own title written with the punctuation a scene may
 * keep as spaces ("S.W.A.T." as "S W A T"), then its alternate titles. */
async function otherTitleQueries(item: MediaItem, suffix: string): Promise<string[]> {
  const loose = looseTitleVariants(item.title).map((title) => `${title}${suffix}`);
  const others = (await alternateTitlesFor(item)).map((title) => `${cleanSceneTitle(title)}${suffix}`);
  return [...loose, ...others];
}

/**
 * The search for one episode row.
 *
 * - A daily show's releases are named by air date ("Show.2024.08.25"), which never parse to a season
 *   and episode: the query is the date, the typed search `season=YYYY&ep=MM/DD`, the target the date.
 * - Anime releases are named by absolute number ("[Group] Show - 25"), which no "S01E25" query finds:
 *   the main query is "Show 25", with "Show S01E25" asked beside it and the other titles as alternates.
 * - A special (season 0) is also searched by its episode title.
 * - Everything else is "Show S01E05", written in the scene's numbering where the show has one.
 */
export async function episodePlanFor(item: MediaItem, ep: any): Promise<SearchPlan> {
  const clean = cleanSceneTitle(item.title);
  const ids = tvSearchIdsOf(item);
  if (item.seriesType === "daily" && ep.air_date) {
    const { spaced, dashed } = dailyDateWords(ep.air_date);
    const query = `${clean} ${spaced}`;
    return {
      query,
      alternateQueries: alternatesFor(query, await otherTitleQueries(item, ` ${spaced}`), [`${clean} ${dashed}`]),
      ids,
      hints: { airDate: dashed, queryTitle: clean },
      // A daily show's release is sometimes numbered ("Show.S2024E123"): the season and episode are accepted too.
      target: { airDate: ep.air_date, season: ep.season_number, episode: ep.episode_number },
    };
  }
  const season: number = ep.scene_season_number ?? ep.season_number;
  const episode: number = ep.scene_episode_number ?? ep.episode_number;
  const standard = `${clean}${episodeSuffix(season, episode)}`;
  const absolute = item.type === "anime" ? await computeAbsoluteEpisodeNumber(item.id, ep.season_number, ep.episode_number) : null;
  const target: ReleaseTarget = {
    season: ep.season_number,
    episode: ep.episode_number,
    sceneSeason: ep.scene_season_number,
    sceneEpisode: ep.scene_episode_number,
    absoluteEpisode: absolute,
    sceneIndex: await sceneIndexFor(item.id),
  };
  const numbers = { season, episode };

  if (item.type === "anime" && absolute != null && absolute > 0) {
    const query = `${clean}${absoluteSuffix(absolute)}`;
    return {
      query,
      // The season form is asked beside it: an indexer that answers "Show 25" with unrelated releases
      // is never found empty, and would not be asked for a release named S01E25.
      alternateQueries: alternatesFor(query, await otherTitleQueries(item, absoluteSuffix(absolute))),
      alsoQueries: [standard],
      ids,
      hints: { ...numbers, absolute, queryTitle: clean },
      target,
    };
  }

  // The special's own title is what a release of it is named by ("The.Office.US.The.Accountants.720p").
  const specialTitle = ep.season_number === 0 && typeof ep.title === "string" ? cleanSceneTitle(ep.title) : "";
  const extra = specialTitle ? [`${clean} ${specialTitle}`] : [];
  return {
    query: standard,
    alternateQueries: alternatesFor(standard, await otherTitleQueries(item, episodeSuffix(season, episode)), extra),
    ids,
    hints: { ...numbers, queryTitle: clean },
    target,
  };
}

/** The search for a season (`episode` null: packs), or for one episode of it (a retry whose failed
 * download was a single episode a season search had found). */
export async function seasonPlanFor(item: MediaItem, season: number, episode: number | null = null): Promise<SearchPlan> {
  const clean = cleanSceneTitle(item.title);
  const suffix = episode == null ? seasonSuffix(season) : episodeSuffix(season, episode);
  const query = `${clean}${suffix}`;
  return {
    query,
    alternateQueries: alternatesFor(query, await otherTitleQueries(item, suffix)),
    ids: tvSearchIdsOf(item),
    hints: { season, episode, queryTitle: clean },
    target: null,
  };
}

/** The search for an item that is one release: a film ("Title 2021") or a ROM ("Title"). */
export async function singlePlanFor(item: MediaItem): Promise<SearchPlan> {
  const query = singleItemQuery(item.type, item.title, item.year);
  const suffix = item.type === "rom" || !item.year ? "" : ` ${item.year}`;
  return {
    query,
    alternateQueries: alternatesFor(query, await otherTitleQueries(item, suffix)),
    ids: parseIds(item),
    hints: {},
    target: null,
  };
}

/** The search for one album, book, issue or chapter (see searchQueries.subItemQuery). */
export function subItemPlanFor(item: Pick<MediaItem, "type" | "title">, sub: { title: string; release_date?: string | null }): SearchPlan {
  const year = sub.release_date ? Number(String(sub.release_date).slice(0, 4)) : NaN;
  const { query, alternateQueries } = subItemQuery(item.type, item.title, sub.title, { releaseYear: Number.isFinite(year) && year > 0 ? year : null });
  return { query, alternateQueries: alternatesFor(query, alternateQueries), ids: {}, hints: subItemHints(item, sub.title), target: null };
}

/** The fields of a typed music or book search: an album is asked for by artist and album, a book by author and
 * the title before its subtitle and series bracket. Other types have no typed search. */
function subItemHints(item: Pick<MediaItem, "type" | "title">, subTitle: string): SearchPlan["hints"] {
  const plain = (text: string) => text.replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  if (item.type === "artist") {
    const album = plain(subTitle);
    return album ? { artist: item.title, album } : {};
  }
  if (item.type === "author") {
    const bookTitle = plain(subTitle.split(/\s*:\s*/)[0]);
    return bookTitle ? { author: item.title, bookTitle } : {};
  }
  return {};
}

/** For each season, the highest episode number that has aired by `today` (a YYYY-MM-DD date): the
 * point from which an undated episode is known to have aired too. */
export function airedFrontierOf(
  episodes: { season_number: number; episode_number: number; air_date?: string | null }[],
  today = new Date().toISOString().slice(0, 10)
): Map<number, number> {
  const frontier = new Map<number, number>();
  for (const e of episodes) {
    if (!e.air_date || e.air_date.slice(0, 10) > today) continue;
    frontier.set(e.season_number, Math.max(frontier.get(e.season_number) ?? -Infinity, e.episode_number));
  }
  return frontier;
}

export async function airedFrontierFor(itemId: number, today = new Date().toISOString().slice(0, 10)): Promise<Map<number, number>> {
  const rows = (await db.prepare("SELECT season_number, episode_number, air_date FROM episodes WHERE media_item_id = ? AND air_date IS NOT NULL").all(itemId)) as {
    season_number: number;
    episode_number: number;
    air_date: string | null;
  }[];
  return airedFrontierOf(rows, today);
}

/**
 * An episode that has not aired. A dated one has not if its date is after `today`. An undated one of a
 * show or an anime has not unless a later episode has aired (`frontier`, from airedFrontierOf): a
 * provider lists episodes it knows have aired without dating them (AniList's schedule covers only a
 * long runner's most recent ones, TVDB's older entries often have no date), and metadata.ts
 * upcomingEpisodes reads them the same way. A daily show's undated episode has no date to search by.
 * A course's or an adult site's episodes have no dates by nature, so they are never held back for lack of one.
 */
export function episodeNotAired(
  item: Pick<MediaItem, "type" | "seriesType">,
  ep: { air_date?: string | null; season_number?: number; episode_number?: number },
  today = new Date().toISOString().slice(0, 10),
  frontier?: Map<number, number>
): boolean {
  if (ep.air_date) return ep.air_date.slice(0, 10) > today;
  if (item.seriesType === "daily") return true;
  if (item.type !== "series" && item.type !== "anime") return false;
  if (frontier && ep.season_number != null && ep.episode_number != null) {
    const last = frontier.get(ep.season_number);
    if (last != null && ep.episode_number < last) return false;
    for (const season of frontier.keys()) if (season > ep.season_number) return false;
  }
  return true;
}
