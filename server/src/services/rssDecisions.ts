import { db } from "../db/index.js";
import { nowExpr } from "../db/asyncDb.js";
import type { SearchResult } from "../types/index.js";

/**
 * What the RSS sync (rssSync.ts) decided about the newest releases of the feeds, kept for the "Recent RSS releases"
 * list on Activity (Starr's release list with no search behind it). Each release is one row: grabbed, held back by a
 * delay profile, rejected (with the reason a search would give), skipped (already queued, nothing to upgrade), or
 * unmatched (it names nothing the library wants). The newest few hundred are kept: a feed lists thousands of releases
 * for what is wanted, so an unmatched release is capped per run and kept in a count of its own, or they would push
 * out the ones that mattered.
 */

export type RssOutcome = "grabbed" | "held" | "rejected" | "unmatched" | "skipped";

/** Judged releases kept (everything but unmatched). */
export const RSS_DECISIONS_KEPT = 200;
/** Unmatched releases kept, and recorded at most per run (the newest). */
export const RSS_UNMATCHED_KEPT = 100;
export const RSS_UNMATCHED_PER_RUN = 50;

export interface RssDecisionInput {
  release: SearchResult;
  outcome: RssOutcome;
  reason: string | null;
  mediaItemId?: number | null;
  episodeId?: number | null;
  subItemId?: number | null;
}

/** When one release has several decisions (a release naming two episodes), the one that did most is kept. */
const OUTCOME_WEIGHT: Record<RssOutcome, number> = { grabbed: 5, held: 4, rejected: 3, skipped: 2, unmatched: 1 };

export function strongerDecision(a: RssDecisionInput | undefined, b: RssDecisionInput): RssDecisionInput {
  return !a || OUTCOME_WEIGHT[b.outcome] > OUTCOME_WEIGHT[a.outcome] ? b : a;
}

/** Saves the decisions of a run, replacing an older row for the same release (a feed read again after a cut-short run), then trims. */
export async function recordRssDecisions(inputs: RssDecisionInput[]): Promise<void> {
  if (inputs.length === 0) return;
  const known = (await db.prepare("SELECT id, indexer_id, title FROM rss_decisions").all()) as { id: number; indexer_id: number | null; title: string }[];
  const idOf = new Map(known.map((r) => [`${r.indexer_id ?? ""}\n${r.title}`, Number(r.id)]));
  for (const input of inputs) {
    const old = idOf.get(`${input.release.indexerId ?? ""}\n${input.release.title}`);
    if (old != null) await db.prepare("DELETE FROM rss_decisions WHERE id = ?").run(old);
    await db
      .prepare(
        "INSERT INTO rss_decisions (indexer_id, title, protocol, outcome, reason, media_item_id, episode_id, sub_item_id, release) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        input.release.indexerId ?? null,
        input.release.title,
        input.release.protocol ?? null,
        input.outcome,
        input.reason,
        input.mediaItemId ?? null,
        input.episodeId ?? null,
        input.subItemId ?? null,
        JSON.stringify(input.release)
      );
  }
  await trimRssDecisions();
}

/** Keeps the newest RSS_DECISIONS_KEPT judged rows and the newest RSS_UNMATCHED_KEPT unmatched ones. */
export async function trimRssDecisions(): Promise<void> {
  await db
    .prepare(
      `DELETE FROM rss_decisions WHERE outcome <> 'unmatched' AND id NOT IN (SELECT id FROM rss_decisions WHERE outcome <> 'unmatched' ORDER BY id DESC LIMIT ${RSS_DECISIONS_KEPT})`
    )
    .run();
  await db
    .prepare(
      `DELETE FROM rss_decisions WHERE outcome = 'unmatched' AND id NOT IN (SELECT id FROM rss_decisions WHERE outcome = 'unmatched' ORDER BY id DESC LIMIT ${RSS_UNMATCHED_KEPT})`
    )
    .run();
}

export interface RssDecisionRow {
  id: number;
  createdAt: string;
  indexerId: number | null;
  indexerName: string | null;
  title: string;
  protocol: string | null;
  outcome: RssOutcome;
  reason: string | null;
  mediaItemId: number | null;
  mediaTitle: string | null;
  episodeId: number | null;
  subItemId: number | null;
}

const SELECT_ROW = `SELECT d.id, d.created_at AS "createdAt", d.indexer_id AS "indexerId", i.name AS "indexerName", d.title, d.protocol, d.outcome, d.reason,
       d.media_item_id AS "mediaItemId", m.title AS "mediaTitle", d.episode_id AS "episodeId", d.sub_item_id AS "subItemId"
     FROM rss_decisions d LEFT JOIN indexers i ON i.id = d.indexer_id LEFT JOIN media_items m ON m.id = d.media_item_id`;

const norm = (row: any): RssDecisionRow => ({
  ...row,
  id: Number(row.id),
  indexerId: row.indexerId == null ? null : Number(row.indexerId),
  mediaItemId: row.mediaItemId == null ? null : Number(row.mediaItemId),
  episodeId: row.episodeId == null ? null : Number(row.episodeId),
  subItemId: row.subItemId == null ? null : Number(row.subItemId),
});

/** The newest first, optionally of one outcome. Never includes the release's download link, which can carry an indexer key. */
export async function listRssDecisions(options: { limit: number; offset: number; outcome?: string | null }): Promise<{ items: RssDecisionRow[]; total: number }> {
  const where = options.outcome ? "WHERE d.outcome = ?" : "";
  const params = options.outcome ? [options.outcome] : [];
  const total = Number(((await db.prepare(`SELECT COUNT(*) AS c FROM rss_decisions d ${where}`).get(...params)) as { c: number }).c);
  const rows = (await db.prepare(`${SELECT_ROW} ${where} ORDER BY d.id DESC LIMIT ? OFFSET ?`).all(...params, options.limit, options.offset)) as any[];
  return { items: rows.map(norm), total };
}

export async function getRssDecision(id: number): Promise<{ row: RssDecisionRow; release: SearchResult | null } | null> {
  const row = (await db.prepare(`${SELECT_ROW} WHERE d.id = ?`).get(id)) as any;
  if (!row) return null;
  const stored = (await db.prepare("SELECT release FROM rss_decisions WHERE id = ?").get(id)) as { release: string | null } | undefined;
  let release: SearchResult | null = null;
  try {
    release = stored?.release ? (JSON.parse(stored.release) as SearchResult) : null;
  } catch {
    release = null;
  }
  return { row: norm(row), release };
}

/** Rewrites what was decided about a release, e.g. after it was mapped by hand and judged again. */
export async function updateRssDecision(
  id: number,
  update: { outcome: RssOutcome; reason: string | null; mediaItemId: number | null; episodeId: number | null; subItemId: number | null }
): Promise<void> {
  await db
    .prepare(`UPDATE rss_decisions SET outcome = ?, reason = ?, media_item_id = ?, episode_id = ?, sub_item_id = ?, created_at = ${nowExpr(db)} WHERE id = ?`)
    .run(update.outcome, update.reason, update.mediaItemId, update.episodeId, update.subItemId, id);
}
