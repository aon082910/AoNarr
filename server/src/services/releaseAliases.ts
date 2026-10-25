import { db } from "../db/index.js";
import { log } from "./logger.js";
import { IDENTITY_RANK, couldNameItem, identityKey, identityModeFor, releaseIdentifiesTarget, releaseNameTokens, type IdentityTarget, type IdentityVerdict } from "./releaseIdentity.js";
import { MEDIA_TYPES } from "./mediaTypes.js";
import { usesQualityTiers } from "./quality.js";
import type { ParsedRelease } from "./releaseParser.js";

/**
 * Alternate titles (MATCHING_ACCURACY_PLAN.md, Round 3): the names a release may use for an item
 * besides the one the metadata provider stores — Sonarr's scene mappings and Radarr's alternative
 * titles. Stored per item in media_item_titles, keyed by cleanTitle, and fed to the identity gate as
 * `aliases`, so "Shingeki.no.Kyojin.S04E01" names "Attack on Titan" and the title an item was
 * scanned in under keeps matching after a rematch.
 */

export type AliasSource = "primary" | "original" | "tmdb_alt" | "anilist_synonym" | "xem_alias" | "user";

export interface AliasRow {
  id: number;
  mediaItemId: number;
  title: string;
  cleanTitle: string;
  source: AliasSource;
  year: number | null;
}

const PROVIDER_SOURCES: AliasSource[] = ["tmdb_alt", "anilist_synonym"];
const COMMON_WORDS = new Set(["a", "an", "the", "and", "or", "of"]);

/** Sonarr's CleanSeriesTitle: identityKey (lowercase, accents folded, punctuation to spaces, roman
 * numerals as digits) less the common words, run together. "The Office (US)" -> "officeus",
 * "Marvel's Agents of S.H.I.E.L.D." -> "marvelsagentsshield", "24" -> "24". */
export function cleanTitle(title: string): string {
  const tokens = identityKey(title).split(" ").filter(Boolean);
  const kept = tokens.filter((t) => !COMMON_WORDS.has(t));
  return (kept.length > 0 ? kept : tokens).join("");
}

function rowFrom(r: any): AliasRow {
  return { id: r.id, mediaItemId: r.media_item_id, title: r.title, cleanTitle: r.clean_title, source: r.source, year: r.year ?? null };
}

export async function aliasRowsFor(mediaItemId: number): Promise<AliasRow[]> {
  const rows = (await db.prepare("SELECT * FROM media_item_titles WHERE media_item_id = ? ORDER BY source, title").all(mediaItemId)) as any[];
  return rows.map(rowFrom);
}

/** The titles the identity gate accepts besides the item's own. In a fixed order, the names the
 * admin gave and the item was scanned in under first, then the providers' (search queries take the
 * first few): the same on every database, whatever order its rows happen to be stored in. */
export async function aliasTitlesFor(mediaItemId: number): Promise<string[]> {
  const rows = (await db
    .prepare(
      `SELECT title FROM media_item_titles WHERE media_item_id = ? AND source <> 'primary'
       ORDER BY CASE source WHEN 'user' THEN 0 WHEN 'original' THEN 1 WHEN 'anilist_synonym' THEN 2 WHEN 'xem_alias' THEN 3 ELSE 4 END, id`
    )
    .all(mediaItemId)) as { title: string }[];
  return rows.map((r) => r.title);
}

const ALIAS_CHUNK = 500;

/** Alias titles for many items at once (the IRC matcher judges every wanted item per announce). With
 * `ids` only those items' rows are read: an item now carries up to forty provider titles, and an
 * announce has no use for the library's other rows. */
export async function aliasTitlesByItem(ids?: number[]): Promise<Map<number, string[]>> {
  const rows: { media_item_id: number; title: string }[] = [];
  if (ids === undefined) {
    rows.push(...((await db.prepare("SELECT media_item_id, title FROM media_item_titles WHERE source <> 'primary'").all()) as typeof rows));
  } else {
    for (let i = 0; i < ids.length; i += ALIAS_CHUNK) {
      const chunk = ids.slice(i, i + ALIAS_CHUNK);
      rows.push(
        ...((await db
          .prepare(`SELECT media_item_id, title FROM media_item_titles WHERE source <> 'primary' AND media_item_id IN (${chunk.map(() => "?").join(", ")})`)
          .all(...chunk)) as typeof rows)
      );
    }
  }
  const byItem = new Map<number, string[]>();
  for (const r of rows) {
    const list = byItem.get(r.media_item_id) ?? [];
    list.push(r.title);
    byItem.set(r.media_item_id, list);
  }
  return byItem;
}

/** Stores `titles` for the item under `source`, skipping empties, duplicates and the item's own
 * title. Returns how many were new. */
export async function storeAliases(mediaItemId: number, titles: string[], source: AliasSource, year: number | null = null): Promise<number> {
  const item = (await db.prepare("SELECT title FROM media_items WHERE id = ?").get(mediaItemId)) as { title: string } | undefined;
  if (!item) return 0;
  const own = cleanTitle(item.title);
  let added = 0;
  const seen = new Set<string>();
  for (const raw of titles) {
    const title = (raw ?? "").trim();
    const clean = cleanTitle(title);
    if (!title || !clean || clean === own || seen.has(clean)) continue;
    seen.add(clean);
    const result = await db
      .prepare(
        `INSERT INTO media_item_titles (media_item_id, title, clean_title, source, year) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (media_item_id, clean_title) DO NOTHING`
      )
      .run(mediaItemId, title, clean, source, year);
    added += result.changes;
  }
  return added;
}

/** Drops the titles a metadata provider supplied for the item's previous match. A rematch moves the
 * item to another work, whose own alternate titles the follow-up refresh fetches. */
export async function clearProviderAliases(mediaItemId: number): Promise<void> {
  await db.prepare("DELETE FROM media_item_titles WHERE media_item_id = ? AND source IN ('tmdb_alt', 'anilist_synonym', 'xem_alias')").run(mediaItemId);
}

/** What a rematch drops: the provider's titles for the old match and the 'original' rows, which are
 * the names an earlier refresh or a duplicate merge replaced and so as likely another work's as this
 * one's. The admin's own ('user') aliases stay. */
export async function clearAliasesOnRematch(mediaItemId: number): Promise<void> {
  await db
    .prepare("DELETE FROM media_item_titles WHERE media_item_id = ? AND source IN ('tmdb_alt', 'anilist_synonym', 'xem_alias', 'original')")
    .run(mediaItemId);
}

/** Replaces the titles a provider gave the item with its current list, in one transaction: a title
 * the provider has since dropped does not stay behind (storeAliases alone only ever adds). The
 * admin's aliases and the item's own names are never touched. */
export async function replaceProviderAliases(mediaItemId: number, titles: string[], source: "tmdb_alt" | "anilist_synonym"): Promise<number> {
  return db.transaction(async () => {
    await db.prepare("DELETE FROM media_item_titles WHERE media_item_id = ? AND source = ?").run(mediaItemId, source);
    return storeAliases(mediaItemId, titles, source);
  });
}

export async function deleteAlias(mediaItemId: number, aliasId: number): Promise<boolean> {
  const result = await db.prepare("DELETE FROM media_item_titles WHERE id = ? AND media_item_id = ? AND source <> 'primary'").run(aliasId, mediaItemId);
  return result.changes > 0;
}

/** Records the item's own title as its clean_title and 'primary' alias row. When the title changed,
 * the old primary row becomes an 'original' alias by default (a provider refresh replacing the
 * scan's guess: releases named the way the item used to be keep matching it). Pass
 * `keepOldTitle: false` when the old title may not be a name of this item at all (a rematch away
 * from a wrong match, the startup backfill): the old primary row is then dropped. A row already
 * holding the new title under another source becomes the primary one. */
export async function syncPrimaryTitle(mediaItemId: number, opts: { keepOldTitle?: boolean } = {}): Promise<void> {
  const item = (await db.prepare("SELECT title, year FROM media_items WHERE id = ?").get(mediaItemId)) as { title: string; year: number | null } | undefined;
  if (!item) return;
  const clean = cleanTitle(item.title);
  await db.prepare("UPDATE media_items SET clean_title = ? WHERE id = ?").run(clean, mediaItemId);
  if (opts.keepOldTitle === false) {
    await db.prepare("DELETE FROM media_item_titles WHERE media_item_id = ? AND source = 'primary' AND clean_title <> ?").run(mediaItemId, clean);
  } else {
    await db.prepare("UPDATE media_item_titles SET source = 'original' WHERE media_item_id = ? AND source = 'primary' AND clean_title <> ?").run(mediaItemId, clean);
  }
  if (!clean) return;
  await db
    .prepare(
      `INSERT INTO media_item_titles (media_item_id, title, clean_title, source, year) VALUES (?, ?, ?, 'primary', ?)
       ON CONFLICT (media_item_id, clean_title) DO UPDATE SET source = 'primary', title = excluded.title, year = excluded.year`
    )
    .run(mediaItemId, item.title, clean, item.year);
}

const BACKFILL_CHUNK = 500;

/** Fills media_items.clean_title (and the primary alias row) for items that lack it or whose title
 * changed — once per startup, cheap, no provider calls. */
export async function backfillCleanTitles(): Promise<number> {
  const rows = (await db.prepare("SELECT id, title, clean_title FROM media_items").all()) as { id: number; title: string; clean_title: string | null }[];
  const stale = rows.filter((row) => row.clean_title !== cleanTitle(row.title));
  // The first start after the upgrade keys every item, and this runs before the server listens:
  // three autocommitted writes per item would be a commit (an fsync) each. A transaction per chunk
  // makes it a handful.
  for (let i = 0; i < stale.length; i += BACKFILL_CHUNK) {
    await db.transaction(async () => {
      for (const row of stale.slice(i, i + BACKFILL_CHUNK)) await syncPrimaryTitle(row.id, { keepOldTitle: false });
    });
  }
  const updated = stale.length;
  if (updated > 0) log.info(`[aliases] keyed ${updated} item title(s) for release matching`);
  return updated;
}

/** The most other titles one search tries beside the main query (indexerClient caps the queries too). */
const MAX_SEARCH_TITLES = 3;

/**
 * The item's search `query` written with its other titles, for an indexer that files a release
 * under one of them: the title less its "(US)" qualifier, the qualifier written without brackets
 * ("The Office US"), then the first two alias rows. Empty for a type with no quality tiers, which
 * has no alias rows, and for a query that does not start with the item's title.
 */
export async function alternateQueriesFor(item: { id: number; type: string; title: string }, query: string): Promise<string[]> {
  if (!usesQualityTiers(item.type) || !query.startsWith(item.title)) return [];
  const rest = query.slice(item.title.length);
  const titles: string[] = [];
  const qualifier = item.title.match(/\s*\(([^()]*)\)\s*$/);
  const base = qualifier ? item.title.slice(0, qualifier.index).trim() : "";
  const spelled = qualifier?.[1].trim();
  // "Charmed (2018)" is searched as "Charmed 2018", never as the bare "Charmed" that is also the
  // other Charmed; "The Office (US)" as "The Office" and "The Office US".
  if (base && spelled && /^(?:19|20)\d{2}$/.test(spelled)) titles.push(`${base} ${spelled}`);
  else if (base) {
    titles.push(base);
    if (spelled) titles.push(`${base} ${spelled}`);
  }
  titles.push(...(await aliasTitlesFor(item.id)).slice(0, 2));
  // Written differently is enough here (an indexer may treat "(US)" and "US" differently), unlike
  // the alias rows, which are kept apart by their clean title.
  const seen = new Set([item.title.trim().toLowerCase()]);
  return titles
    .filter((title) => {
      const key = title.trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_SEARCH_TITLES)
    .map((title) => `${title}${rest}`);
}

/** The item's title without a trailing "(US)"/"(2018)" qualifier, cleaned: what two works that share
 * a title have in common ("The Office (US)" and "The Office (UK)" -> "office"). */
export function baseCleanTitle(title: string): string {
  return cleanTitle(title.replace(/\s*\([^()]*\)\s*$/, "") || title);
}

/** The year in a trailing "(2018)" qualifier, for an item stored without a year of its own. */
function qualifierYearOf(title: string): number | null {
  const m = title.match(/\(((?:19|20)\d{2})\)\s*$/);
  return m ? Number(m[1]) : null;
}

/** A library item that shares a title with another: enough to tell a remake from its original. */
export interface TitleSibling {
  id: number;
  type: string;
  title: string;
  year: number | null;
}

/** Every item of the type whose title is `baseClean` once its qualifier is dropped, watched or not
 * (the first of `candidates` an unsolicited release could name is only ever a wanted one, but a
 * sibling that is already complete still makes the bare title ambiguous). */
export async function sameTitleSiblings(baseClean: string, type: string): Promise<TitleSibling[]> {
  if (!baseClean) return [];
  const rows = (await db
    // Only the rows keyed since the last start have a clean_title (most insert paths leave it NULL until
    // backfillCleanTitles runs), so the few that have none are read too and judged by their title.
    .prepare("SELECT id, type, title, year FROM media_items WHERE type = ? AND (clean_title LIKE ? OR clean_title IS NULL)")
    .all(type, `${baseClean}%`)) as TitleSibling[];
  return rows.filter((r) => baseCleanTitle(r.title) === baseClean);
}

/** What the gate needs to know about an item beyond its own fields: where it was made (stored by the
 * alternate-title lookup) and whether another item shares its title. */
export interface IdentityContext {
  originCountry: string[] | null;
  hasSameBaseSibling: boolean;
  hasEarlierSameTitle: boolean;
}

function originCountryOf(extraMetadata: string | null): string[] | null {
  if (!extraMetadata) return null;
  try {
    const value = JSON.parse(extraMetadata)?.originCountry;
    return Array.isArray(value) && value.length > 0 ? value.filter((c: unknown): c is string => typeof c === "string") : null;
  } catch {
    return null;
  }
}

function contextFrom(item: { id: number; title: string; year: number | null }, siblings: TitleSibling[], originCountry: string[] | null): IdentityContext {
  const others = siblings.filter((s) => s.id !== item.id);
  const year = item.year ?? qualifierYearOf(item.title);
  return {
    originCountry,
    hasSameBaseSibling: others.length > 0,
    hasEarlierSameTitle: year != null && others.some((s) => (s.year ?? qualifierYearOf(s.title)) != null && (s.year ?? qualifierYearOf(s.title))! < year),
  };
}

/** The gate's context for one item (a search, a retry, an import: the target is known). */
export async function identityContextFor(mediaItemId: number): Promise<IdentityContext> {
  const row = (await db.prepare("SELECT id, type, title, year, extra_metadata FROM media_items WHERE id = ?").get(mediaItemId)) as
    | { id: number; type: string; title: string; year: number | null; extra_metadata: string | null }
    | undefined;
  if (!row || !usesQualityTiers(row.type)) return { originCountry: null, hasSameBaseSibling: false, hasEarlierSameTitle: false };
  return contextFrom(row, await sameTitleSiblings(baseCleanTitle(row.title), row.type), originCountryOf(row.extra_metadata));
}

/** An item as the identity gate sees it, aliases and context included. */
export async function identityTargetFor(item: { id: number; type: string; title: string; year: number | null; externalIds: string | null }): Promise<IdentityTarget> {
  let externalIds: Record<string, string> = {};
  try {
    externalIds = item.externalIds ? JSON.parse(item.externalIds) : {};
  } catch {
    externalIds = {};
  }
  return { type: item.type, title: item.title, year: item.year, externalIds, aliases: await aliasTitlesFor(item.id), ...(await identityContextFor(item.id)) };
}

export type ResolveOutcome<T> = { kind: "one"; item: T; verdict: IdentityVerdict } | { kind: "ambiguous"; items: T[] } | { kind: "none" };

/**
 * Which of `candidates` an unsolicited release (an IRC announce, a file on disk) names: the per-item
 * gate run over every candidate, with aliases. The matches are ranked by how good the evidence is
 * (id, title, alias, ... see IDENTITY_RANK) and only the best rank is kept, as Sonarr tries the
 * exact clean title before any looser lookup: "NCIS.S20E05" is NCIS, not ambiguous between it and
 * NCIS: Los Angeles. Then one match is an answer; several of the same rank are ambiguous (Sonarr's
 * MultipleSeriesFoundException) and nothing is grabbed, unless the release's title year singles one
 * out, or the release names no year and the matches are shows of one title, in which case it belongs
 * to the oldest (scene names give the bare title to the original: "Charmed.S01E01" is the 1998 show).
 * `aliases` maps item id to alias titles (aliasTitlesByItem()). `opts.siblings` are library items,
 * wanted or not, that may share a candidate's title; `opts.contexts` is what identityContextFor
 * knows about a candidate (where it was made), by id.
 */
export function resolveReleaseItem<T extends ResolvableItem>(
  release: { title: string },
  parsed: ParsedRelease,
  candidates: T[],
  aliases: Map<number, string[]>,
  opts: ResolveOptions = {}
): ResolveOutcome<T> {
  return pickResolved(judgeCandidates(release, parsed, candidates, aliases, opts), parsed);
}

export type ResolvableItem = { id: number; type: string; title: string; year: number | null; externalIds: string | null; extraMetadata?: Record<string, unknown> | null };
export interface ResolveOptions {
  siblings?: TitleSibling[];
  /** Judge each candidate alone, without taking the other candidates for same-titled siblings. */
  alone?: boolean;
  contexts?: Map<number, Pick<IdentityContext, "originCountry">>;
}

/** The candidates the per-item gate accepts, each with its verdict. */
function judgeCandidates<T extends ResolvableItem>(
  release: { title: string },
  parsed: ParsedRelease,
  candidates: T[],
  aliases: Map<number, string[]>,
  opts: ResolveOptions
): { item: T; verdict: IdentityVerdict }[] {
  // Same-titled items by type and base title, built once instead of searched for every candidate.
  const byBase = new Map<string, TitleSibling[]>();
  if (!opts.alone) {
    for (const o of [...candidates, ...(opts.siblings ?? [])]) {
      const key = `${o.type}|${baseCleanTitle(o.title)}`;
      const list = byBase.get(key);
      if (list) list.push(o);
      else byBase.set(key, [o]);
    }
  }
  // An indexer-reported id can name an item whatever the title says; otherwise only an item that shares
  // a word with the release needs the full comparison.
  const byTitleOnly = !(release as { imdbId?: string | null; tmdbId?: string | null; tvdbId?: string | null }).imdbId && !(release as { tmdbId?: string | null }).tmdbId && !(release as { tvdbId?: string | null }).tvdbId && !parsed.imdbId;
  const releaseTokens = byTitleOnly ? releaseNameTokens(parsed) : null;
  const matches: { item: T; verdict: IdentityVerdict }[] = [];
  for (const item of candidates) {
    if (releaseTokens && !couldNameItem(releaseTokens, item.title, aliases.get(item.id) ?? [])) continue;
    let externalIds: Record<string, string> = {};
    try {
      externalIds = item.externalIds ? JSON.parse(item.externalIds) : {};
    } catch {
      externalIds = {};
    }
    // The containment types (ppv, sports...) are looser per item than their old equality match
    // ("UFC.300.Prelims" contains "UFC 300"); an unsolicited release only gets that looseness once
    // the type's gate enforces.
    const strictTitle = identityModeFor(item.type) !== "enforce";
    const context = contextFrom(item, byBase.get(`${item.type}|${baseCleanTitle(item.title)}`) ?? [], opts.contexts?.get(item.id)?.originCountry ?? null);
    const verdict = releaseIdentifiesTarget(release, parsed, {
      type: item.type,
      title: item.title,
      year: item.year,
      externalIds,
      aliases: aliases.get(item.id) ?? [],
      strictTitle,
      ...context,
    });
    if (verdict.ok) matches.push({ item, verdict });
  }
  return matches;
}

function pickResolved<T extends ResolvableItem>(matches: { item: T; verdict: IdentityVerdict }[], parsed: ParsedRelease): ResolveOutcome<T> {
  if (matches.length === 0) return { kind: "none" };
  const best = Math.min(...matches.map((m) => IDENTITY_RANK[m.verdict.matchType]));
  const top = matches.filter((m) => IDENTITY_RANK[m.verdict.matchType] === best);
  if (top.length === 1) return { kind: "one", ...top[0] };
  if (parsed.titleYear != null) {
    const byYear = top.filter((m) => m.item.year === parsed.titleYear);
    if (byYear.length === 1) return { kind: "one", ...byYear[0] };
  } else if (
    top.every((m) => m.item.type === top[0].item.type && MEDIA_TYPES[m.item.type]?.shape !== "single" && m.item.year != null) &&
    new Set(top.map((m) => baseCleanTitle(m.item.title))).size === 1
  ) {
    // Shows that share a title, not shows that merely share an alias.
    const oldest = Math.min(...top.map((m) => m.item.year as number));
    const earliest = top.filter((m) => m.item.year === oldest);
    if (earliest.length === 1) return { kind: "one", ...earliest[0] };
  }
  return { kind: "ambiguous", items: top.map((m) => m.item) };
}

/**
 * resolveReleaseItem with what only the library knows. The candidates are the wanted items, so the
 * first pass judges them without it; then, for the few that the release names, the items sharing
 * their title are looked up (a remake, the other country's show) and the judgement is made again with
 * the sibling and origin-country context the gate's year and region rules need. The second pass can
 * only narrow the first: context never makes a rejected item acceptable.
 */
export async function resolveReleaseItemInLibrary<T extends ResolvableItem>(
  release: { title: string },
  parsed: ParsedRelease,
  candidates: T[],
  aliases: Map<number, string[]>
): Promise<ResolveOutcome<T>> {
  const named = judgeCandidates(release, parsed, candidates, aliases, { alone: true }).map((m) => m.item);
  if (named.length === 0) return { kind: "none" };
  const bases = new Map<string, { base: string; type: string }>();
  for (const item of named) bases.set(`${item.type}\u0000${baseCleanTitle(item.title)}`, { base: baseCleanTitle(item.title), type: item.type });
  const siblings = (await Promise.all([...bases.values()].map((b) => sameTitleSiblings(b.base, b.type)))).flat();
  const contexts = new Map(named.map((item) => [item.id, { originCountry: originCountryFromExtra(item.extraMetadata) }]));
  return resolveReleaseItem(release, parsed, named, aliases, { siblings, contexts });
}

function originCountryFromExtra(extra: Record<string, unknown> | null | undefined): string[] | null {
  const value = extra?.originCountry;
  return Array.isArray(value) && value.length > 0 ? value.filter((c): c is string => typeof c === "string") : null;
}
