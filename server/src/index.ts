import { log } from "./services/logger.js";
import { config } from "./config.js";
import { startScheduler } from "./services/scheduler.js";
import { createApp } from "./app.js";

const app = await createApp();

app.listen(config.port, () => {
  log.info(`AoNarr server listening on port ${config.port}`);
  startScheduler();
});
