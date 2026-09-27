import path from "node:path";

const configDir = process.env.AONARR_CONFIG_DIR ?? path.resolve(process.cwd(), "..", "data", "config");
const downloadsDir = process.env.AONARR_DOWNLOADS_DIR ?? path.resolve(process.cwd(), "..", "data", "downloads");

export const config = {
  port: Number(process.env.PORT ?? 8989),
  dbPath: path.join(configDir, "aonarr.db"),
  configDir,
  downloadsDir,
  // "sqlite" (default, the only backend the running app actually uses yet) or "postgres" — see
  // DATABASE_MIGRATION.md. AONARR_DATABASE_URL is a standard postgres connection string
  // (postgres://user:pass@host:port/dbname), required when driver is "postgres".
  databaseDriver: (process.env.AONARR_DATABASE_DRIVER ?? "sqlite") as "sqlite" | "postgres",
  databaseUrl: process.env.AONARR_DATABASE_URL ?? null,
  searchIntervalMinutes: Number(process.env.AONARR_SEARCH_INTERVAL_MINUTES ?? 30),
  // Per-cycle cap on how many leaf targets (single items + episodes + sub-items, combined) one
  // runAutoSearch() pass will actually search — see scheduler.ts's runAutoSearch for the
  // oldest-searched-first ordering that makes a backlog bigger than this spread across multiple
  // cycles instead of starving whatever doesn't fit in one. <= 0 (including unset) means "no cap",
  // matching every other "0/unset means off" flag in this codebase (isRootFolderOverQuota's
  // quota_percent, runSeedGoalCleanup's ratio/seed-time goals, ...) and preserving pre-cap behavior
  // exactly for a library whose missing-item backlog was already small enough to finish in one pass.
  // 500 is a deliberately large-but-finite default: generous enough that it's a no-op for the vast
  // majority of libraries (500 simultaneously-missing episodes/sub-items/movies is already a big
  // backlog), while still bounding the worst case — an oversized or freshly-imported library that
  // would otherwise fire one full multi-indexer search per missing item, every searchIntervalMinutes,
  // forever, with no limit at all.
  autoSearchMaxPerCycle: Number(process.env.AONARR_AUTO_SEARCH_MAX_PER_CYCLE ?? 500),
  queuePollIntervalSeconds: Number(process.env.AONARR_QUEUE_POLL_SECONDS ?? 20),
  // Baked in at image build time (see Dockerfile --build-arg) so the update checker can tell
  // "this running container" apart from "what's currently on Docker Hub" for the same tag.
  buildTime: process.env.AONARR_BUILD_TIME ?? null,
  imageTag: process.env.AONARR_IMAGE_TAG ?? null,
};
