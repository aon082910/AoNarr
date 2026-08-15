import { db } from "../db/client.js";

export function recordGroupSuccess(releaseGroup: string | null): void {
  if (!releaseGroup) return;
  db.prepare(
    `INSERT INTO release_group_stats (release_group, successes) VALUES (?, 1)
     ON CONFLICT(release_group) DO UPDATE SET successes = successes + 1`
  ).run(releaseGroup);
}

export function recordGroupFailure(releaseGroup: string | null): void {
  if (!releaseGroup) return;
  db.prepare(
    `INSERT INTO release_group_stats (release_group, failures) VALUES (?, 1)
     ON CONFLICT(release_group) DO UPDATE SET failures = failures + 1`
  ).run(releaseGroup);
}

/** Success rate in [0, 1] for tie-breaking search results; a group with no history at all gets a
 * neutral 0.5 rather than being penalized for being unproven, and a group needs at least 3 known
 * outcomes before its rate is trusted over "no data" — a single lucky/unlucky grab shouldn't
 * swing future ranking. */
export function getGroupReputation(releaseGroup: string | null): number {
  if (!releaseGroup) return 0.5;
  const row = db.prepare("SELECT successes, failures FROM release_group_stats WHERE release_group = ?").get(releaseGroup) as
    | { successes: number; failures: number }
    | undefined;
  if (!row) return 0.5;
  const total = row.successes + row.failures;
  if (total < 3) return 0.5;
  return row.successes / total;
}

export interface ReleaseGroupStatsRow {
  releaseGroup: string;
  successes: number;
  failures: number;
  successRate: number;
}

export function listReleaseGroupStats(): ReleaseGroupStatsRow[] {
  const rows = db.prepare("SELECT * FROM release_group_stats").all() as {
    release_group: string;
    successes: number;
    failures: number;
  }[];
  return rows
    .map((r) => ({
      releaseGroup: r.release_group,
      successes: r.successes,
      failures: r.failures,
      successRate: r.successes + r.failures > 0 ? r.successes / (r.successes + r.failures) : 0,
    }))
    .sort((a, b) => b.successes + b.failures - (a.successes + a.failures));
}
