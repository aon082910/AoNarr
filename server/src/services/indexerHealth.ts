import { db } from "../db/index.js";

/** Keeps indexer_health from growing unbounded on a busy instance — the last 50 attempts per
 * indexer is plenty for a meaningful success-rate/response-time summary without needing a
 * separate cleanup job. */
const MAX_ROWS_PER_INDEXER = 50;

/** Records one real search attempt (see searchIndexer() in indexerClient.ts, the single choke
 * point every manual/auto-search/wanted-list/test-button search goes through) and prunes older
 * rows for that indexer past the cap. Never throws — a health-logging failure shouldn't be able to
 * mask the actual search result/error it's describing. */
export async function recordIndexerHealth(
  indexerId: number,
  success: boolean,
  responseTimeMs: number | null,
  error: string | null
): Promise<void> {
  try {
    await db
      .prepare(`INSERT INTO indexer_health (indexer_id, success, response_time_ms, error) VALUES (?, ?, ?, ?)`)
      .run(indexerId, success ? 1 : 0, responseTimeMs, error);

    await db
      .prepare(
        `DELETE FROM indexer_health WHERE indexer_id = ? AND id NOT IN (
           SELECT id FROM indexer_health WHERE indexer_id = ? ORDER BY id DESC LIMIT ?
         )`
      )
      .run(indexerId, indexerId, MAX_ROWS_PER_INDEXER);
  } catch {
    // best-effort — see doc comment above
  }
}

export interface IndexerHealthSummary {
  totalChecks: number;
  successCount: number;
  /** 0-100, or null when there's no history yet for this indexer. */
  successRate: number | null;
  avgResponseTimeMs: number | null;
  lastCheckedAt: string | null;
  lastSuccess: boolean | null;
  lastError: string | null;
}

const EMPTY_HEALTH: IndexerHealthSummary = {
  totalChecks: 0,
  successCount: 0,
  successRate: null,
  avgResponseTimeMs: null,
  lastCheckedAt: null,
  lastSuccess: null,
  lastError: null,
};

/** Attaches a `health` summary (success rate, avg response time, last check) to each indexer,
 * mutating in place — mirrors attachChildCounts()'s pattern (one grouped query for the whole list
 * rather than one query per indexer) from services/childCounts.ts. */
export async function attachIndexerHealth(indexers: { id: number }[]): Promise<void> {
  if (indexers.length === 0) return;
  const ids = indexers.map((i) => i.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = (await db
    .prepare(
      `SELECT indexer_id, success, response_time_ms, error, checked_at
       FROM indexer_health WHERE indexer_id IN (${placeholders}) ORDER BY id DESC`
    )
    .all(...ids)) as {
    indexer_id: number;
    success: number;
    response_time_ms: number | null;
    error: string | null;
    checked_at: string;
  }[];

  const byIndexer = new Map<number, typeof rows>();
  for (const row of rows) {
    if (!byIndexer.has(row.indexer_id)) byIndexer.set(row.indexer_id, []);
    byIndexer.get(row.indexer_id)!.push(row);
  }

  for (const indexer of indexers as any[]) {
    // Rows are already ORDER BY id DESC (most recent first) from the query above.
    const checks = byIndexer.get(indexer.id) ?? [];
    if (checks.length === 0) {
      indexer.health = EMPTY_HEALTH;
      continue;
    }
    const successCount = checks.filter((c) => c.success).length;
    const timed = checks.filter((c) => c.response_time_ms != null);
    const avgResponseTimeMs =
      timed.length > 0 ? Math.round(timed.reduce((sum, c) => sum + (c.response_time_ms ?? 0), 0) / timed.length) : null;
    const last = checks[0];
    indexer.health = {
      totalChecks: checks.length,
      successCount,
      successRate: Math.round((successCount / checks.length) * 100),
      avgResponseTimeMs,
      lastCheckedAt: last.checked_at,
      lastSuccess: !!last.success,
      lastError: last.success ? null : last.error,
    } satisfies IndexerHealthSummary;
  }
}
