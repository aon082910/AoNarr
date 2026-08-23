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
  queuePollIntervalSeconds: Number(process.env.AONARR_QUEUE_POLL_SECONDS ?? 20),
  // Baked in at image build time (see Dockerfile --build-arg) so the update checker can tell
  // "this running container" apart from "what's currently on Docker Hub" for the same tag.
  buildTime: process.env.AONARR_BUILD_TIME ?? null,
  imageTag: process.env.AONARR_IMAGE_TAG ?? null,
};
