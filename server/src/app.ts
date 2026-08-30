import express, { type Express } from "express";
import cors from "cors";
import { initDb } from "./db/index.js";
import { loadSettingsCache } from "./services/settingsStore.js";
import { loadQualityCaches } from "./services/quality.js";
import { backfillEpisodicAndCollectionHasFile, backfillMissingAlbumTracks } from "./services/libraryScan.js";
import { errorHandler, asyncHandler } from "./middleware/errorHandler.js";
import { requireAuth } from "./middleware/auth.js";
import { bootstrapAdminFromEnv } from "./services/bootstrapAdmin.js";
import { applySocksProxySetting } from "./services/socksProxy.js";

import { mediaRouter } from "./routes/media.js";
import { indexersRouter } from "./routes/indexers.js";
import { downloadClientsRouter } from "./routes/downloadClients.js";
import { qualityProfilesRouter } from "./routes/qualityProfiles.js";
import { delayProfilesRouter } from "./routes/delayProfiles.js";
import { rootFoldersRouter } from "./routes/rootFolders.js";
import { searchRouter } from "./routes/search.js";
import { activityRouter } from "./routes/activity.js";
import { subtitlesRouter } from "./routes/subtitles.js";
import { settingsRouter } from "./routes/settings.js";
import { metadataRouter } from "./routes/metadata.js";
import { wantedRouter } from "./routes/wanted.js";
import { importRouter } from "./routes/import.js";
import { systemRouter } from "./routes/system.js";
import { tagsRouter } from "./routes/tags.js";
import { customFormatsRouter } from "./routes/customFormats.js";
import { tracksRouter } from "./routes/tracks.js";
import { qualitiesRouter } from "./routes/qualities.js";
import { artworkRouter } from "./routes/artwork.js";
import { mediaTypesRouter } from "./routes/mediaTypesRoute.js";
import { librarySearchRouter } from "./routes/librarySearch.js";
import { collectionsRouter } from "./routes/collections.js";
import { authRouter } from "./routes/authRoutes.js";
import { usersRouter } from "./routes/users.js";
import { userInvitesRouter, inviteAcceptRouter } from "./routes/userInvites.js";
import { requestsRouter } from "./routes/requests.js";
import { discoverRouter } from "./routes/discover.js";
import { aiProvidersRouter } from "./routes/aiProviders.js";
import { customColumnsRouter } from "./routes/customColumns.js";
import { iptvRouter, iptvPublicRouter } from "./routes/iptv.js";
import { opdsTokenRouter, opdsPublicRouter } from "./routes/opds.js";
import { handleMcpRequest } from "./mcp/server.js";
import { blocklistRouter } from "./routes/blocklist.js";
import { recommendationsRouter } from "./routes/recommendations.js";
import { auditLogRouter } from "./routes/auditLog.js";
import { pushRouter } from "./routes/push.js";
import { metricsRouter } from "./routes/metrics.js";
import { watchlistImportRouter } from "./routes/watchlistImport.js";
import { calendarFeedRouter, calendarTokenRouter } from "./routes/calendarFeed.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { importExclusionsRouter } from "./routes/importExclusions.js";
import { mediaServerWebhookRouter, mediaServerWebhookTokenRouter } from "./routes/mediaServerWebhook.js";
import { overseerrWebhookRouter, overseerrWebhookTokenRouter } from "./routes/overseerrWebhook.js";
import { discordCommandRouter, discordInteractionsRouter } from "./routes/discordInteractions.js";
import { mediaAnalysisRouter } from "./routes/mediaAnalysis.js";
import { importReviewRouter } from "./routes/importReview.js";
import { mediaServerImportRouter } from "./routes/mediaServerImport.js";
import { starrImportRouter } from "./routes/starrImport.js";
import { openApiSpec } from "./openapi.js";
import { contentRatingsRouter } from "./routes/contentRatingsRoute.js";
import { changelogRouter } from "./routes/changelog.js";
import { peopleRouter } from "./routes/people.js";
import { remoteInstancesRouter } from "./routes/remoteInstances.js";
import { importListsRouter } from "./routes/importLists.js";
import { shareLinksRouter, shareLinksPublicRouter } from "./routes/shareLinks.js";
import { updateCheckRouter } from "./routes/updateCheck.js";
import { libraryGroupsRouter } from "./routes/libraryGroups.js";
import { libraryViewsRouter } from "./routes/libraryViews.js";
import { calendarEventsRouter } from "./routes/calendarEvents.js";
import { jobsRouter } from "./routes/jobs.js";
import { recycleBinRouter } from "./routes/recycleBin.js";
import { duplicatesRouter } from "./routes/duplicates.js";
import { corruptMediaReviewRouter } from "./routes/corruptMediaReview.js";
import { themeRouter } from "./routes/theme.js";
import { friendLibrariesRouter } from "./routes/friendLibraries.js";

/**
 * Builds and returns the fully-initialized Express app (DB ready, settings/quality caches warm,
 * every route registered) WITHOUT starting the HTTP listener or the cron scheduler — split out of
 * index.ts so tests (server/tests/**) can supertest-drive real routes against a real (SQLite or
 * Postgres) database without also spinning up background jobs. index.ts is the only caller that
 * should follow this with app.listen()/startScheduler().
 */
export async function createApp(): Promise<Express> {
  await initDb();
  await loadSettingsCache();
  await loadQualityCaches();
  await bootstrapAdminFromEnv();
  applySocksProxySetting();
  await backfillEpisodicAndCollectionHasFile();
  await backfillMissingAlbumTracks();

  const app = express();
  app.use(cors());
  // `verify` stashes the exact raw request bytes on req.rawBody before JSON-parsing — needed by
  // the Discord interactions webhook (routes/discordInteractions.ts), which must verify an
  // Ed25519 signature over the literal bytes Discord sent; re-serializing the parsed JSON
  // wouldn't byte-for-byte match the original body, so the parsed object alone isn't enough.
  app.use(
    express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );
  app.use("/api", asyncHandler(requireAuth));

  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/openapi.json", (req, res) => {
    if (!req.auth?.isAdmin) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    res.json(openApiSpec);
  });

  app.use("/api/auth", authRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/users/invites", userInvitesRouter);
  app.use("/api/invite", inviteAcceptRouter);
  app.use("/api/requests", requestsRouter);
  app.use("/api/discover", discoverRouter);
  app.use("/api/ai-providers", aiProvidersRouter);
  app.use("/api/custom-columns", customColumnsRouter);
  // Public (token-gated) routes mounted before the admin router at the same base path — their own
  // specific sub-paths (/m3u/:id, /stream/:kind/:id) are what requireAuth's exemption list
  // actually matches on, so they need to be reachable before iptvRouter's requireAdmin gate would
  // otherwise reject them.
  app.use("/api/iptv", iptvPublicRouter);
  app.use("/api/iptv", iptvRouter);
  app.use("/api/settings/opds-token", opdsTokenRouter);
  app.use("/api/opds", opdsPublicRouter);
  // MCP (Model Context Protocol) endpoint — lets an MCP client (Claude, another agent) drive
  // AoNarr directly. No separate token: it sits behind the same requireAuth gate as every other
  // /api route, so an MCP client authenticates with the instance API key exactly like any other
  // automation already does.
  app.all("/api/mcp", asyncHandler(handleMcpRequest));
  app.use("/api/media", mediaRouter);
  app.use("/api/indexers", indexersRouter);
  app.use("/api/download-clients", downloadClientsRouter);
  app.use("/api/quality-profiles", qualityProfilesRouter);
  app.use("/api/delay-profiles", delayProfilesRouter);
  app.use("/api/root-folders", rootFoldersRouter);
  app.use("/api/search", searchRouter);
  app.use("/api/activity", activityRouter);
  app.use("/api/subtitles", subtitlesRouter);
  app.use("/api/settings/calendar-token", calendarTokenRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/metadata", metadataRouter);
  app.use("/api/wanted", wantedRouter);
  app.use("/api/import", importRouter);
  app.use("/api/system", systemRouter);
  app.use("/api/tags", tagsRouter);
  app.use("/api/custom-formats", customFormatsRouter);
  app.use("/api/media", tracksRouter);
  app.use("/api/qualities", qualitiesRouter);
  app.use("/api/media", artworkRouter);
  app.use("/api/media-types", mediaTypesRouter);
  app.use("/api/library-search", librarySearchRouter);
  app.use("/api/collections", collectionsRouter);
  app.use("/api/blocklist", blocklistRouter);
  app.use("/api/recommendations", recommendationsRouter);
  app.use("/api/audit-log", auditLogRouter);
  app.use("/api/push", pushRouter);
  app.use("/api/metrics", metricsRouter);
  app.use("/api/watchlist-import", watchlistImportRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/import-exclusions", importExclusionsRouter);
  app.use("/api/settings/media-server-webhook-token", mediaServerWebhookTokenRouter);
  app.use("/api/webhooks/media-server", mediaServerWebhookRouter);
  app.use("/api/settings/overseerr-webhook-token", overseerrWebhookTokenRouter);
  app.use("/api/webhooks/overseerr", overseerrWebhookRouter);
  app.use("/api/settings/discord-command", discordCommandRouter);
  app.use("/api/discord/interactions", discordInteractionsRouter);
  app.use("/api/content-ratings", contentRatingsRouter);
  app.use("/api/changelog", changelogRouter);
  app.use("/api/people", peopleRouter);
  app.use("/api/remote-instances", remoteInstancesRouter);
  app.use("/api/calendar.ics", calendarFeedRouter);
  app.use("/api/import-lists", importListsRouter);
  app.use("/api/share", shareLinksPublicRouter);
  app.use("/api/media", shareLinksRouter);
  app.use("/api/settings/update-check", updateCheckRouter);
  app.use("/api/library-groups", libraryGroupsRouter);
  app.use("/api/library-views", libraryViewsRouter);
  app.use("/api/calendar-events", calendarEventsRouter);
  app.use("/api/jobs", jobsRouter);
  app.use("/api/recycle-bin", recycleBinRouter);
  app.use("/api/duplicates", duplicatesRouter);
  app.use("/api/corrupt-media-review", corruptMediaReviewRouter);
  app.use("/api/theme.css", themeRouter);
  app.use("/api/friend-libraries", friendLibrariesRouter);
  app.use("/api/media-analysis", mediaAnalysisRouter);
  app.use("/api/import-review", importReviewRouter);
  app.use("/api/media-server-import", mediaServerImportRouter);
  app.use("/api/starr-import", starrImportRouter);

  app.use(errorHandler);

  return app;
}
