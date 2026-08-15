import path from "node:path";

const configDir = process.env.AONARR_CONFIG_DIR ?? path.resolve(process.cwd(), "..", "data", "config");
const downloadsDir = process.env.AONARR_DOWNLOADS_DIR ?? path.resolve(process.cwd(), "..", "data", "downloads");

export const config = {
  port: Number(process.env.PORT ?? 8989),
  dbPath: path.join(configDir, "aonarr.db"),
  configDir,
  downloadsDir,
  searchIntervalMinutes: Number(process.env.AONARR_SEARCH_INTERVAL_MINUTES ?? 30),
  queuePollIntervalSeconds: Number(process.env.AONARR_QUEUE_POLL_SECONDS ?? 20),
};
