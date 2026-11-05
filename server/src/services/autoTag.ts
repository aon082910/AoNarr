import { db } from "../db/index.js";
import { nowExpr } from "../db/asyncDb.js";
import { log } from "./logger.js";
import { isValidMediaType, MEDIA_TYPES } from "./mediaTypes.js";
import { createYielder } from "./fsAsync.js";
import { isJobBusy, listJobs, registerJob, runJobWithResult, type JobDef } from "./jobRegistry.js";
import { finishBackgroundJob, incrementBackgroundJobDone, startBackgroundJob } from "./backgroundJobs.js";

/**
 * Auto tagging (Sonarr's and Radarr's "Auto Tagging"): a rule names conditions on a title and tags to give it.
 *
 * Conditions are deliberately few: the library type, the genre and the import list (a title that was added by the list,
 * or that the list holds right now). Within one condition any value is enough ("movie or series", "Anime or Animation");
 * between conditions `match` decides: "any" = one condition that holds is enough, "all" = every condition the rule
 * has must hold. A rule with no condition at all is refused, so it cannot tag the whole library by accident.
 *
 * Provenance: a tag the rule adds is recorded in `media_item_auto_tags` (rule, title, tag). Only a rule with
 * `remove_when_unmatched` ever removes a tag, and only one it recorded itself, once the title stops matching. A tag the
 * title already had (set by hand, by a list or by a root folder) is never recorded, so it can never be removed here, and a tag
 * set by hand afterwards takes the rule's claim away (releaseAutoOwnership). Deleting a rule, or switching it off, leaves
 * its tags on the titles as plain tags.
 *
 * Evaluation runs when a title is added (addDefaults.ts and the two add routes), after a metadata refresh (genres and
 * ids may have changed), after an import list sync, and for a whole library on demand (the rule's Apply button, or the
 * weekly "Auto Tagging" job). It never throws into the code that added or refreshed the title.
 */

export type AutoTagMatch = "any" | "all";

export interface AutoTagRule {
  id: number;
  name: string;
  enabled: boolean;
  match: AutoTagMatch;
  libraryTypes: string[];
  genres: string[];
  listIds: number[];
  tagIds: number[];
  removeWhenUnmatched: boolean;
  createdAt: string;
  updatedAt: string;
}

// --- rows and input ----------------------------------------------------------------------------------------------

function jsonList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const strings = (raw: unknown): string[] => jsonList(raw).filter((v): v is string => typeof v === "string");
const ids = (raw: unknown): number[] => [...new Set(jsonList(raw).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

export function ruleFromRow(row: any): AutoTagRule {
  return {
    id: Number(row.id),
    name: String(row.name),
    enabled: !!Number(row.enabled),
    match: row.match_mode === "all" ? "all" : "any",
    libraryTypes: strings(row.library_types),
    genres: strings(row.genres),
    listIds: ids(row.list_ids),
    tagIds: ids(row.tag_ids),
    removeWhenUnmatched: !!Number(row.remove_when_unmatched),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** A request the caller got wrong: the route answers with `status` (400, or 409 for a name that is taken) and the message. */
export class AutoTagInputError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

export interface AutoTagRuleInput {
  name?: unknown;
  enabled?: unknown;
  match?: unknown;
  libraryTypes?: unknown;
  genres?: unknown;
  listIds?: unknown;
  tagIds?: unknown;
  removeWhenUnmatched?: unknown;
}

type RuleValues = Omit<AutoTagRule, "id" | "createdAt" | "updatedAt">;

const MAX_NAME_LENGTH = 100;
const MAX_GENRE_LENGTH = 80;
const MAX_GENRES = 200;

function listInput(value: unknown, field: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new AutoTagInputError(`${field} must be a list`);
  return value;
}

function idListInput(value: unknown, field: string): number[] {
  const out = listInput(value, field).map(Number);
  if (out.some((n) => !Number.isInteger(n) || n <= 0)) throw new AutoTagInputError(`${field} must be a list of ids`);
  return [...new Set(out)];
}

function boolInput(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  throw new AutoTagInputError(`${field} must be true or false`);
}

/** Trimmed, empty ones dropped, and one spelling kept of a genre given twice in different case. */
function genreInput(value: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of listInput(value, "genres")) {
    if (typeof item !== "string") throw new AutoTagInputError("genres must be a list of names");
    const genre = item.trim();
    if (!genre) continue;
    if (genre.length > MAX_GENRE_LENGTH) throw new AutoTagInputError(`A genre can be at most ${MAX_GENRE_LENGTH} characters`);
    if (seen.has(genre.toLowerCase())) continue;
    seen.add(genre.toLowerCase());
    out.push(genre);
  }
  if (out.length > MAX_GENRES) throw new AutoTagInputError(`A rule can name at most ${MAX_GENRES} genres`);
  return out;
}

/** The values a rule would have with `input` applied over `existing`, checked. Throws AutoTagInputError. */
async function checkedValues(input: AutoTagRuleInput, existing: AutoTagRule | null): Promise<RuleValues> {
  const name = (input.name === undefined && existing ? existing.name : input.name) as unknown;
  if (typeof name !== "string" || !name.trim()) throw new AutoTagInputError("name is required");
  if (name.trim().length > MAX_NAME_LENGTH) throw new AutoTagInputError(`name can be at most ${MAX_NAME_LENGTH} characters`);

  const matchInput = input.match === undefined ? existing?.match ?? "any" : input.match;
  if (matchInput !== "any" && matchInput !== "all") throw new AutoTagInputError('match must be "any" or "all"');

  const libraryTypes = input.libraryTypes === undefined && existing ? existing.libraryTypes : [...new Set(listInput(input.libraryTypes, "libraryTypes").map(String))];
  for (const type of libraryTypes) if (!isValidMediaType(type)) throw new AutoTagInputError(`Unknown library type "${type}"`);

  const genres = input.genres === undefined && existing ? existing.genres : genreInput(input.genres);
  const listIds = input.listIds === undefined && existing ? existing.listIds : idListInput(input.listIds, "listIds");
  const tagIds = input.tagIds === undefined && existing ? existing.tagIds : idListInput(input.tagIds, "tagIds");

  if (tagIds.length === 0) throw new AutoTagInputError("A rule needs at least one tag to give");
  if (libraryTypes.length === 0 && genres.length === 0 && listIds.length === 0) {
    throw new AutoTagInputError("A rule needs at least one condition (a library type, a genre or an import list): without one it would tag the whole library");
  }
  for (const id of input.tagIds === undefined && existing ? [] : tagIds) {
    if (!(await db.prepare("SELECT 1 AS ok FROM tags WHERE id = ?").get(id))) throw new AutoTagInputError(`Tag ${id} doesn't exist`);
  }
  // Only the lists the request sends are checked: one deleted since stays in the rule as an id that no title ever matches
  // (so the rule never gets broader), and switching the rule on or off must not need it fixed first.
  for (const id of input.listIds === undefined && existing ? [] : listIds) {
    if (!(await db.prepare("SELECT 1 AS ok FROM import_lists WHERE id = ?").get(id))) throw new AutoTagInputError(`Import list ${id} doesn't exist`);
  }
  const clash = (await db.prepare("SELECT id FROM auto_tag_rules WHERE LOWER(name) = LOWER(?)").get(name.trim())) as { id: number } | undefined;
  if (clash && Number(clash.id) !== existing?.id) throw new AutoTagInputError(`A rule named "${name.trim()}" already exists`, 409);

  return {
    name: name.trim(),
    enabled: boolInput(input.enabled, "enabled", existing?.enabled ?? true),
    match: matchInput,
    libraryTypes,
    genres,
    listIds,
    tagIds,
    removeWhenUnmatched: boolInput(input.removeWhenUnmatched, "removeWhenUnmatched", existing?.removeWhenUnmatched ?? false),
  };
}

// --- rule storage and the cache ----------------------------------------------------------------------------------

/** Enabled rules, read again after this long or after any write to a rule (a restore restarts the process anyway). */
const RULES_CACHE_MS = 10_000;
let rulesCache: { at: number; rules: AutoTagRule[] } | null = null;

/** Forgets the cached rules: every write below calls it, and a test that edits the table directly must too. */
export function invalidateAutoTagRules(): void {
  rulesCache = null;
}

export async function listAutoTagRules(): Promise<AutoTagRule[]> {
  const rows = (await db.prepare("SELECT * FROM auto_tag_rules ORDER BY LOWER(name), id").all()) as any[];
  return rows.map(ruleFromRow);
}

export async function getAutoTagRule(id: number): Promise<AutoTagRule | null> {
  const row = await db.prepare("SELECT * FROM auto_tag_rules WHERE id = ?").get(id);
  return row ? ruleFromRow(row) : null;
}

async function enabledRules(): Promise<AutoTagRule[]> {
  if (rulesCache && Date.now() - rulesCache.at < RULES_CACHE_MS) return rulesCache.rules;
  const rules = (await listAutoTagRules()).filter((r) => r.enabled);
  rulesCache = { at: Date.now(), rules };
  return rules;
}

export async function createAutoTagRule(input: AutoTagRuleInput): Promise<AutoTagRule> {
  const v = await checkedValues(input, null);
  const result = await db
    .prepare(
      `INSERT INTO auto_tag_rules (name, enabled, match_mode, library_types, genres, list_ids, tag_ids, remove_when_unmatched)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(v.name, v.enabled ? 1 : 0, v.match, JSON.stringify(v.libraryTypes), JSON.stringify(v.genres), JSON.stringify(v.listIds), JSON.stringify(v.tagIds), v.removeWhenUnmatched ? 1 : 0);
  invalidateAutoTagRules();
  return (await getAutoTagRule(Number(result.lastInsertRowid)))!;
}

/** Changes the fields `input` names. Null when there is no such rule. */
export async function updateAutoTagRule(id: number, input: AutoTagRuleInput): Promise<AutoTagRule | null> {
  const existing = await getAutoTagRule(id);
  if (!existing) return null;
  const v = await checkedValues(input, existing);
  await db
    .prepare(
      `UPDATE auto_tag_rules SET name = ?, enabled = ?, match_mode = ?, library_types = ?, genres = ?, list_ids = ?, tag_ids = ?,
       remove_when_unmatched = ?, updated_at = ${nowExpr(db)} WHERE id = ?`
    )
    .run(v.name, v.enabled ? 1 : 0, v.match, JSON.stringify(v.libraryTypes), JSON.stringify(v.genres), JSON.stringify(v.listIds), JSON.stringify(v.tagIds), v.removeWhenUnmatched ? 1 : 0, id);
  // A rule that is switched off lets go of its tags: they stay on the titles as plain tags, and switching the rule on
  // again does not take them back (it only ever removes what it adds from then on).
  if (existing.enabled && !v.enabled) await db.prepare("DELETE FROM media_item_auto_tags WHERE rule_id = ?").run(id);
  invalidateAutoTagRules();
  return getAutoTagRule(id);
}

/** The tags it gave stay on the titles as plain tags (the provenance rows go with the rule). False when there is no such rule. */
export async function deleteAutoTagRule(id: number): Promise<boolean> {
  const result = await db.prepare("DELETE FROM auto_tag_rules WHERE id = ?").run(id);
  invalidateAutoTagRules();
  return Number(result.changes) > 0;
}

/** The rules that give a tag (a tag in use by a rule cannot be deleted, as for a delay profile or an indexer). */
export async function autoTagRulesUsingTag(tagId: number): Promise<{ id: number; name: string }[]> {
  return (await listAutoTagRules()).filter((r) => r.tagIds.includes(tagId)).map((r) => ({ id: r.id, name: r.name }));
}

// --- conditions --------------------------------------------------------------------------------------------------

interface ItemRow {
  id: number;
  type: string;
  title: string;
  year: number | null;
  genres: string | null;
  external_ids: string | null;
  source_list_id: number | null;
}

const ITEM_COLUMNS = "id, type, title, year, genres, external_ids, source_list_id";

export interface ItemFacts {
  type: string;
  /** Lowercased. */
  genres: Set<string>;
  /** The ids of the import lists that added the title or hold it now. */
  lists: Set<number>;
}

function genresOf(raw: string | null): Set<string> {
  const out = new Set<string>();
  for (const g of strings(raw)) {
    const genre = g.trim().toLowerCase();
    if (genre) out.add(genre);
  }
  return out;
}

/** Whether the title meets the rule's conditions. A rule with no condition meets none. */
export function ruleMatches(rule: Pick<AutoTagRule, "match" | "libraryTypes" | "genres" | "listIds">, facts: ItemFacts): boolean {
  const checks: boolean[] = [];
  if (rule.libraryTypes.length > 0) checks.push(rule.libraryTypes.includes(facts.type));
  if (rule.genres.length > 0) checks.push(rule.genres.some((g) => facts.genres.has(g.trim().toLowerCase())));
  if (rule.listIds.length > 0) checks.push(rule.listIds.some((id) => facts.lists.has(id)));
  if (checks.length === 0) return false;
  return rule.match === "all" ? checks.every(Boolean) : checks.some(Boolean);
}

/**
 * The keys under which an import list recorded a title (import_list_entries): `<type>:tmdb:<id>`, `<type>:imdb:<id>`,
 * `artist:name:<name>`. The same keys as itemListKeys() in importLists.ts, which this file cannot import (it would
 * be a cycle through addDefaults.ts); tests/autoTag.test.ts checks the two agree.
 */
export function listKeysOfItem(item: { type: string; title: string; external_ids: string | null }): string[] {
  const keys: string[] = [];
  try {
    const parsed = JSON.parse(item.external_ids ?? "{}") ?? {};
    if (parsed.tmdb) keys.push(`${item.type}:tmdb:${parsed.tmdb}`);
    if (parsed.imdb) keys.push(`${item.type}:imdb:${parsed.imdb}`);
  } catch {
    // an unreadable id list gives no id keys
  }
  if (item.type === "artist") keys.push(`artist:name:${item.title.toLowerCase()}`);
  return keys;
}

const QUERY_CHUNK = 200;

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

/** For each title, which of `listIds` added it or hold it now. One indexed query per few hundred titles. */
async function listMembership(items: ItemRow[], listIds: number[]): Promise<Map<number, Set<number>>> {
  const out = new Map<number, Set<number>>();
  if (listIds.length === 0) return out;
  const wanted = new Set(listIds);
  const itemsByKey = new Map<string, number[]>();
  for (const item of items) {
    if (item.source_list_id != null && wanted.has(Number(item.source_list_id))) out.set(item.id, new Set([Number(item.source_list_id)]));
    for (const key of listKeysOfItem(item)) itemsByKey.set(key, [...(itemsByKey.get(key) ?? []), item.id]);
  }
  const keys = [...itemsByKey.keys()];
  for (let i = 0; i < keys.length; i += QUERY_CHUNK * 2) {
    const chunk = keys.slice(i, i + QUERY_CHUNK * 2);
    const rows = (await db
      .prepare(`SELECT list_id, entry_key FROM import_list_entries WHERE list_id IN (${placeholders(listIds.length)}) AND entry_key IN (${placeholders(chunk.length)})`)
      .all(...listIds, ...chunk)) as { list_id: number; entry_key: string }[];
    for (const row of rows) {
      for (const itemId of itemsByKey.get(row.entry_key) ?? []) {
        const set = out.get(itemId) ?? new Set<number>();
        set.add(Number(row.list_id));
        out.set(itemId, set);
      }
    }
  }
  return out;
}

// --- planning and applying ---------------------------------------------------------------------------------------

export interface ItemState {
  /** The tags the title has now. */
  tags: Set<number>;
  /** Tag id -> the rules that gave it. */
  owners: Map<number, Set<number>>;
}

export type TagOp =
  /** Gives the title a tag it lacked, recorded as the rule's. */
  | { kind: "add"; tagId: number; ruleId: number }
  /** The tag is there and another rule gave it: this rule shares the claim, so it stays while either matches. */
  | { kind: "share"; tagId: number; ruleId: number }
  /** The rule's claim on the tag ends (the tag itself goes only with a following "remove"). */
  | { kind: "release"; tagId: number; ruleId: number }
  /** The last rule that gave the tag let go of it. */
  | { kind: "remove"; tagId: number };

/**
 * What the rules change on one title, without touching the database: the tags to add (the ones it lacks), the claims to
 * record, and, for a rule with remove_when_unmatched, the tags it gave that no longer fit. `matched` are the rules whose
 * conditions hold.
 */
export function planItem(rules: AutoTagRule[], facts: ItemFacts, state: ItemState): { ops: TagOp[]; matched: Set<number> } {
  const ops: TagOp[] = [];
  const tags = new Set(state.tags);
  const owners = new Map<number, Set<number>>();
  for (const [tagId, ruleIds] of state.owners) {
    if (tags.has(tagId)) {
      owners.set(tagId, new Set(ruleIds));
    } else {
      // Taken off by hand since: a claim on a tag the title no longer has is void.
      for (const ruleId of ruleIds) ops.push({ kind: "release", tagId, ruleId });
    }
  }

  const matched = new Set<number>();
  for (const rule of rules) {
    try {
      if (ruleMatches(rule, facts)) matched.add(rule.id);
    } catch (err) {
      log.warn(`[autoTag] rule "${rule.name}" could not be evaluated:`, (err as Error).message);
    }
  }

  for (const rule of rules) {
    if (!matched.has(rule.id)) continue;
    for (const tagId of rule.tagIds) {
      if (!tags.has(tagId)) {
        tags.add(tagId);
        owners.set(tagId, new Set([rule.id]));
        ops.push({ kind: "add", tagId, ruleId: rule.id });
        continue;
      }
      // Present already: by hand (no claim, left alone for good), or given by another rule (share the claim).
      const claim = owners.get(tagId);
      if (claim && claim.size > 0 && !claim.has(rule.id)) {
        claim.add(rule.id);
        ops.push({ kind: "share", tagId, ruleId: rule.id });
      }
    }
  }

  for (const rule of rules) {
    if (!rule.removeWhenUnmatched) continue;
    const keep = matched.has(rule.id) ? new Set(rule.tagIds) : new Set<number>();
    for (const [tagId, claim] of owners) {
      if (!claim.has(rule.id) || keep.has(tagId)) continue;
      claim.delete(rule.id);
      ops.push({ kind: "release", tagId, ruleId: rule.id });
      if (claim.size === 0) {
        owners.delete(tagId);
        tags.delete(tagId);
        ops.push({ kind: "remove", tagId });
      }
    }
  }
  return { ops, matched };
}

/**
 * Runs the planned changes one by one: a statement that fails (a tag deleted in the meantime) is logged and the rest go on, so
 * one broken rule never stops another. A tag is removed only when this very run took the last claim away, so a tag the admin
 * set by hand a moment ago (which deletes the claims) is never removed from under them.
 */
async function applyOps(itemId: number, ops: TagOp[]): Promise<{ added: number; removed: number }> {
  let added = 0;
  let removed = 0;
  const released = new Set<number>();
  const failed = new Set<number>();
  for (const op of ops) {
    try {
      if (op.kind === "add") {
        const inserted = await db.prepare("INSERT INTO media_item_tags (media_item_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(itemId, op.tagId);
        if (Number(inserted.changes) > 0) {
          // The claim is written second: a failure between the two leaves a plain tag, never a claim without a tag.
          await db.prepare("INSERT INTO media_item_auto_tags (media_item_id, tag_id, rule_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(itemId, op.tagId, op.ruleId);
          added++;
        }
      } else if (op.kind === "share") {
        await db.prepare("INSERT INTO media_item_auto_tags (media_item_id, tag_id, rule_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(itemId, op.tagId, op.ruleId);
      } else if (op.kind === "release") {
        const gone = await db.prepare("DELETE FROM media_item_auto_tags WHERE media_item_id = ? AND tag_id = ? AND rule_id = ?").run(itemId, op.tagId, op.ruleId);
        if (Number(gone.changes) > 0) released.add(op.tagId);
      } else if (released.has(op.tagId) && !failed.has(op.tagId)) {
        const stillClaimed = await db.prepare("SELECT 1 AS ok FROM media_item_auto_tags WHERE media_item_id = ? AND tag_id = ?").get(itemId, op.tagId);
        if (!stillClaimed) {
          const gone = await db.prepare("DELETE FROM media_item_tags WHERE media_item_id = ? AND tag_id = ?").run(itemId, op.tagId);
          if (Number(gone.changes) > 0) removed++;
        }
      }
    } catch (err) {
      if ("tagId" in op) failed.add(op.tagId);
      log.warn(`[autoTag] could not ${op.kind} tag ${"tagId" in op ? op.tagId : ""} on item ${itemId}:`, (err as Error).message);
    }
  }
  return { added, removed };
}

async function loadStates(itemIds: number[]): Promise<Map<number, ItemState>> {
  const states = new Map<number, ItemState>();
  for (const id of itemIds) states.set(id, { tags: new Set(), owners: new Map() });
  for (let i = 0; i < itemIds.length; i += QUERY_CHUNK) {
    const chunk = itemIds.slice(i, i + QUERY_CHUNK);
    const tagRows = (await db.prepare(`SELECT media_item_id, tag_id FROM media_item_tags WHERE media_item_id IN (${placeholders(chunk.length)})`).all(...chunk)) as {
      media_item_id: number;
      tag_id: number;
    }[];
    for (const row of tagRows) states.get(Number(row.media_item_id))?.tags.add(Number(row.tag_id));
    const claimRows = (await db
      .prepare(`SELECT media_item_id, tag_id, rule_id FROM media_item_auto_tags WHERE media_item_id IN (${placeholders(chunk.length)})`)
      .all(...chunk)) as { media_item_id: number; tag_id: number; rule_id: number }[];
    for (const row of claimRows) {
      const state = states.get(Number(row.media_item_id));
      if (!state) continue;
      const claim = state.owners.get(Number(row.tag_id)) ?? new Set<number>();
      claim.add(Number(row.rule_id));
      state.owners.set(Number(row.tag_id), claim);
    }
  }
  return states;
}

export interface TitleChange {
  id: number;
  title: string;
  year: number | null;
  type: string;
  adds: string[];
  removes: string[];
}

export interface AutoTagRunResult {
  /** Titles looked at. */
  scanned: number;
  /** Titles that meet the conditions of at least one of the rules. */
  matching: number;
  /** Titles that gained (a preview: would gain) at least one tag. */
  itemsGaining: number;
  /** Titles that lost (would lose) at least one tag. */
  itemsLosing: number;
  tagsAdded: number;
  tagsRemoved: number;
  /** A preview's examples of what changes, at most `sampleLimit`. */
  samples: TitleChange[];
  cancelled: boolean;
}

export interface AutoTagRunOptions {
  rules: AutoTagRule[];
  /** Plan and count, write nothing. */
  dryRun?: boolean;
  signal?: AbortSignal;
  sampleLimit?: number;
  /** Only these titles; otherwise every title in the library, in id order. */
  itemIds?: number[];
  onProgress?: (scanned: number) => void;
}

async function tagNames(): Promise<Map<number, string>> {
  const rows = (await db.prepare("SELECT id, name FROM tags").all()) as { id: number; name: string }[];
  return new Map(rows.map((r) => [Number(r.id), r.name]));
}

/**
 * Evaluates the rules for a set of titles (or the whole library), a few hundred at a time. Between chunks the event loop is
 * given back and the cancel signal looked at, and no transaction is held open: every change is its own statement, the
 * run can stop at any point and starting it again finishes the job (nothing is added twice).
 */
export async function runAutoTag(options: AutoTagRunOptions): Promise<AutoTagRunResult> {
  const { dryRun = false, signal, sampleLimit = 0 } = options;
  const result: AutoTagRunResult = { scanned: 0, matching: 0, itemsGaining: 0, itemsLosing: 0, tagsAdded: 0, tagsRemoved: 0, samples: [], cancelled: false };
  if (options.rules.length === 0) return result;
  // A tag deleted since the rule was written is not given (it would only fail on the foreign key every time).
  const names = await tagNames();
  const rules = options.rules.map((r) => ({ ...r, tagIds: r.tagIds.filter((id) => names.has(id)) }));
  const listIds = [...new Set(rules.flatMap((r) => r.listIds))];
  const yieldNow = createYielder(10);

  const handle = async (rows: ItemRow[]): Promise<void> => {
    const [membership, states] = await Promise.all([listMembership(rows, listIds), loadStates(rows.map((r) => r.id))]);
    for (const row of rows) {
      const facts: ItemFacts = { type: row.type, genres: genresOf(row.genres), lists: membership.get(row.id) ?? new Set() };
      const state = states.get(row.id)!;
      const { ops, matched } = planItem(rules, facts, state);
      result.scanned++;
      if (matched.size > 0) result.matching++;
      const wouldAdd = ops.filter((o) => o.kind === "add").length;
      const wouldRemove = ops.filter((o) => o.kind === "remove").length;
      let added = wouldAdd;
      let removed = wouldRemove;
      if (!dryRun && ops.length > 0) ({ added, removed } = await applyOps(row.id, ops));
      if (added > 0) result.itemsGaining++;
      if (removed > 0) result.itemsLosing++;
      result.tagsAdded += added;
      result.tagsRemoved += removed;
      if ((added > 0 || removed > 0) && result.samples.length < sampleLimit) {
        const nameOf = (o: TagOp) => names.get(o.tagId) ?? `#${o.tagId}`;
        result.samples.push({
          id: row.id,
          title: row.title,
          year: row.year == null ? null : Number(row.year),
          type: row.type,
          adds: ops.filter((o) => o.kind === "add").map(nameOf),
          removes: ops.filter((o) => o.kind === "remove").map(nameOf),
        });
      }
      await yieldNow();
    }
    options.onProgress?.(rows.length);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  if (options.itemIds) {
    const wanted = [...new Set(options.itemIds)].sort((a, b) => a - b);
    for (let i = 0; i < wanted.length; i += QUERY_CHUNK) {
      if (signal?.aborted) {
        result.cancelled = true;
        break;
      }
      const chunk = wanted.slice(i, i + QUERY_CHUNK);
      const rows = (await db.prepare(`SELECT ${ITEM_COLUMNS} FROM media_items WHERE id IN (${placeholders(chunk.length)}) ORDER BY id`).all(...chunk)) as ItemRow[];
      await handle(rows.map(normalizeRow));
    }
    return result;
  }

  let lastId = 0;
  for (;;) {
    if (signal?.aborted) {
      result.cancelled = true;
      break;
    }
    const rows = (await db.prepare(`SELECT ${ITEM_COLUMNS} FROM media_items WHERE id > ? ORDER BY id LIMIT ${QUERY_CHUNK}`).all(lastId)) as ItemRow[];
    if (rows.length === 0) break;
    lastId = Number(rows[rows.length - 1].id);
    await handle(rows.map(normalizeRow));
  }
  return result;
}

function normalizeRow(row: any): ItemRow {
  return { ...row, id: Number(row.id), source_list_id: row.source_list_id == null ? null : Number(row.source_list_id) };
}

// --- the hooks ---------------------------------------------------------------------------------------------------

/**
 * Applies every enabled rule to one title: adds the tags it lacks and, for a rule with remove_when_unmatched, takes back
 * the ones a rule gave that no longer fit. Called after a title is added and after it is refreshed. Cheap (the rules are
 * cached, a title costs a few indexed queries), idempotent, and it never throws: a failure is logged and the add or the
 * refresh that called it carries on.
 */
export async function evaluateRulesForItem(item: number | bigint | { id: number | bigint } | null | undefined): Promise<{ added: number; removed: number }> {
  const none = { added: 0, removed: 0 };
  try {
    const id = item != null && typeof item === "object" ? Number(item.id) : item == null ? NaN : Number(item);
    if (!Number.isInteger(id)) return none;
    const rules = await enabledRules();
    if (rules.length === 0) return none;
    const result = await runAutoTag({ rules, itemIds: [id] });
    return { added: result.tagsAdded, removed: result.tagsRemoved };
  } catch (err) {
    log.warn(`[autoTag] could not evaluate the rules for item ${String(item)}:`, (err as Error).message);
    return none;
  }
}

/**
 * After an import list synced: the titles it holds right now (also those it did not add, because they were in the library
 * already) and those a rule that names this list tagged earlier (they may have dropped off the list) are evaluated.
 * Nothing to do when no enabled rule names the list.
 */
export async function evaluateRulesAfterListSync(listId: number, held: Set<string>): Promise<void> {
  try {
    const rules = await enabledRules();
    const forList = rules.filter((r) => r.listIds.includes(listId));
    if (forList.length === 0) return;
    const candidates = new Set<number>();
    const types = [...new Set([...held].map((key) => key.slice(0, key.indexOf(":"))).filter(Boolean))];
    if (types.length > 0) {
      const rows = (await db.prepare(`SELECT id, type, title, external_ids FROM media_items WHERE type IN (${placeholders(types.length)})`).all(...types)) as any[];
      for (const row of rows) if (listKeysOfItem(row).some((key) => held.has(key))) candidates.add(Number(row.id));
    }
    const added = (await db.prepare("SELECT id FROM media_items WHERE source_list_id = ?").all(listId)) as { id: number }[];
    for (const row of added) candidates.add(Number(row.id));
    const tagged = (await db
      .prepare(`SELECT DISTINCT media_item_id FROM media_item_auto_tags WHERE rule_id IN (${placeholders(forList.length)})`)
      .all(...forList.map((r) => r.id))) as { media_item_id: number }[];
    for (const row of tagged) candidates.add(Number(row.media_item_id));
    if (candidates.size === 0) return;
    const result = await runAutoTag({ rules, itemIds: [...candidates] });
    if (result.tagsAdded > 0 || result.tagsRemoved > 0) {
      log.info(`[autoTag] after the sync of list ${listId}: ${result.tagsAdded} tag(s) added, ${result.tagsRemoved} removed`);
    }
  } catch (err) {
    log.warn(`[autoTag] could not evaluate the rules after the sync of list ${listId}:`, (err as Error).message);
  }
}

/**
 * The admin set a tag by hand (or took it off): any claim a rule had on it ends, so the tag is the admin's from then on and a
 * rule that stops matching never removes it.
 */
export async function releaseAutoOwnership(itemIds: Array<number | string>, tagId: number | string): Promise<void> {
  const all = itemIds.map(Number).filter((n) => Number.isInteger(n));
  for (let i = 0; i < all.length; i += 500) {
    const chunk = all.slice(i, i + 500);
    await db.prepare(`DELETE FROM media_item_auto_tags WHERE tag_id = ? AND media_item_id IN (${placeholders(chunk.length)})`).run(Number(tagId), ...chunk);
  }
}

// --- previews, "apply to the library" and the job ----------------------------------------------------------------

export interface ApplySummary {
  ruleId: number | null;
  startedAt: string;
  finishedAt: string | null;
  total: number;
  scanned: number;
  matching: number;
  itemsGaining: number;
  itemsLosing: number;
  tagsAdded: number;
  tagsRemoved: number;
  cancelled: boolean;
  error: string | null;
}

const lastApply = new Map<number | "all", ApplySummary>();

/** How the last run of a rule since the server started went (not kept across a restart); null when there was none. */
export function lastApplyOf(ruleId: number | "all"): ApplySummary | null {
  return lastApply.get(ruleId) ?? null;
}

/** What a rule would do to the library right now, without writing anything: counts and up to 20 example titles. */
export async function previewAutoTagRule(rule: AutoTagRule): Promise<AutoTagRunResult> {
  // A switched-off rule is previewed as if it were on, so the admin can see what switching it on would do.
  return runAutoTag({ rules: [{ ...rule, enabled: true }], dryRun: true, sampleLimit: 20 });
}

export const AUTO_TAG_JOB = "autoTag";

async function countTitles(): Promise<number> {
  const row = (await db.prepare("SELECT COUNT(*) AS c FROM media_items").get()) as { c: number | string };
  return Number(row.c);
}

/** One tracked run (progress in the Background Jobs widget, counts in `lastApply`) of `rules` over the whole library. */
async function trackedRun(rules: AutoTagRule[], key: number | "all", label: string, signal: AbortSignal): Promise<AutoTagRunResult> {
  const total = await countTitles();
  const type = key === "all" ? "all" : `rule-${key}`;
  let jobId: string | null = null;
  try {
    jobId = startBackgroundJob("autoTag", type, label, total);
  } catch {
    // the widget already shows a run with this id; the job registry never lets two runs overlap, so this is only a stale entry
  }
  const summary: ApplySummary = {
    ruleId: key === "all" ? null : key,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    total,
    scanned: 0,
    matching: 0,
    itemsGaining: 0,
    itemsLosing: 0,
    tagsAdded: 0,
    tagsRemoved: 0,
    cancelled: false,
    error: null,
  };
  lastApply.set(key, summary);
  try {
    const result = await runAutoTag({ rules, signal, onProgress: (n) => incrementBackgroundJobDone("autoTag", type, n) });
    Object.assign(summary, { scanned: result.scanned, matching: result.matching, itemsGaining: result.itemsGaining, itemsLosing: result.itemsLosing, tagsAdded: result.tagsAdded, tagsRemoved: result.tagsRemoved, cancelled: result.cancelled });
    log.info(
      `[autoTag] ${label}: ${result.scanned} title(s) checked, ${result.matching} match, ${result.tagsAdded} tag(s) added on ${result.itemsGaining} title(s), ${result.tagsRemoved} removed${result.cancelled ? " (cancelled)" : ""}`
    );
    return result;
  } catch (err) {
    summary.error = (err as Error).message;
    throw err;
  } finally {
    summary.finishedAt = new Date().toISOString();
    if (jobId) finishBackgroundJob(jobId, summary.error ?? undefined);
  }
}

/** The weekly job and its "Run now": every enabled rule over the whole library, the way a rule's Apply button does it for one. */
async function runAllRules(signal: AbortSignal): Promise<void> {
  const rules = (await listAutoTagRules()).filter((r) => r.enabled);
  if (rules.length === 0) return;
  await trackedRun(rules, "all", "Auto tagging", signal);
}

/** The "Auto Tagging" job: the scheduler registers it at start-up. */
export const AUTO_TAG_JOB_DEF: JobDef = {
  key: AUTO_TAG_JOB,
  name: "Auto Tagging",
  scheduleType: "cron",
  // Sunday, after the other weekly jobs: only a safety net, since the rules run on every add, refresh and list sync.
  defaultSchedule: "10 5 * * 0",
  run: (signal) => runAllRules(signal),
};

/** Makes sure the job is registered (the Apply route needs it, and a process that never started the scheduler has not). */
export function registerAutoTagJob(): void {
  if (!listJobs().some((j) => j.key === AUTO_TAG_JOB)) registerJob(AUTO_TAG_JOB_DEF);
}

/**
 * Starts one rule's Apply to the whole library as a run of the "Auto Tagging" job (one at a time, cancellable from the Jobs
 * page, recorded in its history) and returns at once; progress is in the Background Jobs widget. A run of the job
 * already going (this rule's, another's, or the weekly one) is not doubled.
 */
export async function startAutoTagApply(rule: AutoTagRule): Promise<{ started: boolean; reason?: string }> {
  registerAutoTagJob();
  if (isJobBusy(AUTO_TAG_JOB)) return { started: false, reason: "already-running" };
  void runJobWithResult(AUTO_TAG_JOB, (signal) => trackedRun([rule], rule.id, `Auto tagging: ${rule.name}`, signal)).catch((err) =>
    log.warn(`[autoTag] applying "${rule.name}" failed:`, (err as Error).message)
  );
  return { started: true };
}

// --- what the page needs and the settings template ---------------------------------------------------------------

export async function autoTagMeta(): Promise<{
  libraryTypes: { key: string; label: string }[];
  genres: string[];
  lists: { id: number; name: string; type: string }[];
}> {
  const rows = (await db.prepare("SELECT genres FROM media_items WHERE genres IS NOT NULL").all()) as { genres: string }[];
  const byLower = new Map<string, string>();
  for (const row of rows) {
    for (const g of strings(row.genres)) {
      const genre = g.trim();
      if (genre && !byLower.has(genre.toLowerCase())) byLower.set(genre.toLowerCase(), genre);
    }
  }
  const lists = (await db.prepare("SELECT id, name, type FROM import_lists ORDER BY LOWER(name), id").all()) as { id: number; name: string; type: string }[];
  return {
    libraryTypes: Object.values(MEDIA_TYPES).map((t) => ({ key: t.key, label: t.label })),
    genres: [...byLower.values()].sort((a, b) => a.localeCompare(b)).slice(0, 500),
    lists: lists.map((l) => ({ id: Number(l.id), name: l.name, type: l.type })),
  };
}

/** The rules in the settings template: tags and lists by name, because ids differ between installs. */
export async function exportAutoTagRules(): Promise<unknown[]> {
  const tagNameById = await tagNames();
  const lists = (await db.prepare("SELECT id, name FROM import_lists").all()) as { id: number; name: string }[];
  const listNameById = new Map(lists.map((l) => [Number(l.id), l.name]));
  return (await listAutoTagRules()).map((r) => ({
    name: r.name,
    enabled: r.enabled,
    match: r.match,
    libraryTypes: r.libraryTypes,
    genres: r.genres,
    listNames: r.listIds.map((id) => listNameById.get(id)).filter((n): n is string => !!n),
    tagNames: r.tagIds.map((id) => tagNameById.get(id)).filter((n): n is string => !!n),
    removeWhenUnmatched: r.removeWhenUnmatched,
  }));
}

/**
 * Imports rules from a template, matched by name (an existing rule of that name is updated in place). A condition never gets
 * broader on the way in: a library type this install does not know, or a list it has no list of that name for, is left out, and
 * a rule whose whole condition would vanish that way is skipped with a note instead. `tagIdByName` creates a missing tag.
 */
export async function importAutoTagRules(entries: unknown[], tagIdByName: (name: string) => Promise<number>): Promise<{ imported: number; notes: string[] }> {
  const notes: string[] = [];
  let imported = 0;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name.trim() : "";
    if (!name) continue;
    const named = (value: unknown): string[] => (Array.isArray(value) ? value.map((v) => String(v).trim()).filter((v) => v.length > 0) : []);

    const wantedTypes = named(e.libraryTypes);
    const libraryTypes = wantedTypes.filter(isValidMediaType);
    if (wantedTypes.length > 0 && libraryTypes.length === 0) {
      notes.push(`Auto tagging rule "${name}" skipped: this install has none of its library types (${wantedTypes.join(", ")})`);
      continue;
    }
    const wantedLists = named(e.listNames);
    const listIds: number[] = [];
    for (const listName of wantedLists) {
      const rows = (await db.prepare("SELECT id FROM import_lists WHERE name = ?").all(listName)) as { id: number }[];
      for (const row of rows) listIds.push(Number(row.id));
    }
    if (wantedLists.length > 0 && listIds.length === 0) {
      notes.push(`Auto tagging rule "${name}" skipped: no import list named ${wantedLists.map((n) => `"${n}"`).join(", ")} on this install`);
      continue;
    }
    const wantedTags = named(e.tagNames);
    if (wantedTags.length === 0) {
      notes.push(`Auto tagging rule "${name}" skipped: it names no tag`);
      continue;
    }
    const tagIds: number[] = [];
    for (const tagName of wantedTags) tagIds.push(await tagIdByName(tagName));

    const input: AutoTagRuleInput = {
      name,
      enabled: e.enabled === false ? false : true,
      match: e.match === "all" ? "all" : "any",
      libraryTypes,
      genres: named(e.genres),
      listIds,
      tagIds,
      removeWhenUnmatched: e.removeWhenUnmatched === true,
    };
    try {
      const existing = ((await listAutoTagRules()).find((r) => r.name.toLowerCase() === name.toLowerCase())) ?? null;
      if (existing) await updateAutoTagRule(existing.id, input);
      else await createAutoTagRule(input);
      imported++;
    } catch (err) {
      if (err instanceof AutoTagInputError) notes.push(`Auto tagging rule "${name}" skipped: ${err.message}`);
      else throw err;
    }
  }
  return { imported, notes };
}
