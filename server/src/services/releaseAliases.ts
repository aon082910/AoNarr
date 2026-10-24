import { db } from "../db/index.js";
import { log } from "./logger.js";
import { identityKey, identityModeFor, releaseIdentifiesTarget, type IdentityTarget, type IdentityVerdict } from "./releaseIdentity.js";
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

/** The titles the identity gate accepts besides the item's own. */
export async function aliasTitlesFor(mediaItemId: number): Promise<string[]> {
  const rows = (await db.prepare("SELECT title FROM media_item_titles WHERE media_item_id = ? AND source <> 'primary'").all(mediaItemId)) as { title: string }[];
  return rows.map((r) => r.title);
}

/** Alias titles for many items at once (the IRC matcher judges every monitored item per announce). */
export async function aliasTitlesByItem(): Promise<Map<number, string[]>> {
  const rows = (await db.prepare("SELECT media_item_id, title FROM media_item_titles WHERE source <> 'primary'").all()) as { media_item_id: number; title: string }[];
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
  if (base) titles.push(base);
  const spelled = qualifier?.[1].trim();
  if (base && spelled && !/^(?:19|20)\d{2}$/.test(spelled)) titles.push(`${base} ${spelled}`);
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

/** An item as the identity gate sees it, aliases included. */
export async function identityTargetFor(item: { id: number; type: string; title: string; year: number | null; externalIds: string | null }): Promise<IdentityTarget> {
  let externalIds: Record<string, string> = {};
  try {
    externalIds = item.externalIds ? JSON.parse(item.externalIds) : {};
  } catch {
    externalIds = {};
  }
  return { type: item.type, title: item.title, year: item.year, externalIds, aliases: await aliasTitlesFor(item.id) };
}

export type ResolveOutcome<T> = { kind: "one"; item: T; verdict: IdentityVerdict } | { kind: "ambiguous"; items: T[] } | { kind: "none" };

/**
 * Which of `candidates` an unsolicited release (an IRC announce, a file on disk) names: the per-item
 * gate run over every candidate, with aliases. Exactly one match is an answer; two or more is
 * ambiguous (Sonarr's MultipleSeriesFoundException) and nothing is grabbed, unless the release's
 * title year singles one out. `aliases` maps item id to alias titles (aliasTitlesByItem()).
 */
export function resolveReleaseItem<T extends { id: number; type: string; title: string; year: number | null; externalIds: string | null }>(
  release: { title: string },
  parsed: ParsedRelease,
  candidates: T[],
  aliases: Map<number, string[]>
): ResolveOutcome<T> {
  const matches: { item: T; verdict: IdentityVerdict }[] = [];
  for (const item of candidates) {
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
    const verdict = releaseIdentifiesTarget(release, parsed, { type: item.type, title: item.title, year: item.year, externalIds, aliases: aliases.get(item.id) ?? [], strictTitle });
    if (verdict.ok) matches.push({ item, verdict });
  }
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "one", ...matches[0] };
  if (parsed.titleYear != null) {
    const byYear = matches.filter((m) => m.item.year === parsed.titleYear);
    if (byYear.length === 1) return { kind: "one", ...byYear[0] };
  }
  return { kind: "ambiguous", items: matches.map((m) => m.item) };
}
