import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import { db, initDb } from "./db/index.js";
import { loadSettingsCache, getSetting } from "./services/settingsStore.js";
import { loadQualityCaches } from "./services/quality.js";
import { backfillEpisodicAndCollectionHasFile, backfillMissingAlbumTracks } from "./services/libraryScan.js";
import { errorHandler, asyncHandler } from "./middleware/errorHandler.js";
import { requireAdmin, requireAuth } from "./middleware/auth.js";
import { bootstrapAdminFromEnv } from "./services/bootstrapAdmin.js";
import { applySocksProxySetting } from "./services/socksProxy.js";
import { generateRequestId, runWithRequestId } from "./services/requestContext.js";
import { recordHttpRequest } from "./services/httpMetrics.js";
import { encryptValue, isEncryptedValue } from "./services/encryption.js";
import { log } from "./services/logger.js";

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
import { releaseProfilesRouter } from "./routes/releaseProfiles.js";
import { tracksRouter } from "./routes/tracks.js";
import { qualitiesRouter } from "./routes/qualities.js";
import { artworkRouter } from "./routes/artwork.js";
import { localArtworkRouter } from "./routes/localArtwork.js";
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
import { ircFeedsRouter } from "./routes/ircFeeds.js";
import { plexAuthRouter } from "./routes/plexAuth.js";
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
import { remotePathMappingsRouter } from "./routes/remotePathMappings.js";
import { jobsRouter } from "./routes/jobs.js";
import { recycleBinRouter } from "./routes/recycleBin.js";
import { duplicatesRouter } from "./routes/duplicates.js";
import { corruptMediaReviewRouter } from "./routes/corruptMediaReview.js";
import { themeRouter } from "./routes/theme.js";
import { friendLibrariesRouter } from "./routes/friendLibraries.js";

/**
 * download_clients.password/.api_key, irc_feeds.sasl_pass, ai_providers.api_key, indexers.api_key,
 * and subtitle_providers.api_key live in their own dedicated tables rather than the generic
 * `settings` table, so settingsStore.ts's own self-healing re-encryption (loadSettingsCache) never
 * sees them — an install that predates encryption-at-rest support for these tables has plaintext
 * rows here. Same idea, scoped to these instead: read, and if a value isn't already in our
 * encrypted format, encrypt and write it back, so a stolen/leaked DB backup can't recover it in
 * plaintext from the next boot onward without anyone re-entering it by hand.
 */
async function reencryptLegacyCredentials(): Promise<void> {
  let count = 0;

  const clients = (await db.prepare("SELECT id, password, api_key FROM download_clients").all()) as {
    id: number;
    password: string | null;
    api_key: string | null;
  }[];
  for (const c of clients) {
    const sets: string[] = [];
    const values: string[] = [];
    if (c.password && !isEncryptedValue(c.password)) {
      sets.push("password = ?");
      values.push(encryptValue(c.password));
    }
    if (c.api_key && !isEncryptedValue(c.api_key)) {
      sets.push("api_key = ?");
      values.push(encryptValue(c.api_key));
    }
    if (sets.length > 0) {
      values.push(String(c.id));
      await db.prepare(`UPDATE download_clients SET ${sets.join(", ")} WHERE id = ?`).run(...values);
      count++;
    }
  }

  const feeds = (await db.prepare("SELECT id, sasl_pass FROM irc_feeds").all()) as { id: number; sasl_pass: string | null }[];
  for (const f of feeds) {
    if (f.sasl_pass && !isEncryptedValue(f.sasl_pass)) {
      await db.prepare("UPDATE irc_feeds SET sasl_pass = ? WHERE id = ?").run(encryptValue(f.sasl_pass), f.id);
      count++;
    }
  }

  const providers = (await db.prepare("SELECT id, api_key FROM ai_providers").all()) as { id: number; api_key: string | null }[];
  for (const p of providers) {
    if (p.api_key && !isEncryptedValue(p.api_key)) {
      await db.prepare("UPDATE ai_providers SET api_key = ? WHERE id = ?").run(encryptValue(p.api_key), p.id);
      count++;
    }
  }

  const indexerRows = (await db.prepare("SELECT id, api_key FROM indexers").all()) as { id: number; api_key: string | null }[];
  for (const i of indexerRows) {
    if (i.api_key && !isEncryptedValue(i.api_key)) {
      await db.prepare("UPDATE indexers SET api_key = ? WHERE id = ?").run(encryptValue(i.api_key), i.id);
      count++;
    }
  }

  const subtitleProviders = (await db.prepare("SELECT id, api_key FROM subtitle_providers").all()) as {
    id: number;
    api_key: string | null;
  }[];
  for (const sp of subtitleProviders) {
    if (sp.api_key && !isEncryptedValue(sp.api_key)) {
      await db.prepare("UPDATE subtitle_providers SET api_key = ? WHERE id = ?").run(encryptValue(sp.api_key), sp.id);
      count++;
    }
  }

  if (count > 0) log.info(`[encryption] encrypted ${count} legacy plaintext credential(s) at rest`);
}

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
  await reencryptLegacyCredentials();
  await loadQualityCaches();
  await bootstrapAdminFromEnv();
  applySocksProxySetting();
  await backfillEpisodicAndCollectionHasFile();
  await backfillMissingAlbumTracks();

  const app = express();
  // CSP and Cross-Origin-Resource-Policy are left off: this is an SPA that pulls poster/backdrop
  // images from arbitrary metadata-provider and indexer URLs, and getting a CSP right for that
  // without live-testing every provider risks silently breaking images/embeds rather than
  // improving security meaningfully for a single-admin self-hosted app. Every other helmet
  // default (nosniff, frame-options, referrer-policy, etc.) is safe to enable unconditionally.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
  // Wide open (reflects whatever Origin the browser sends) by default, same as before this
  // setting existed — this API is header-based (X-Api-Key/X-Session-Token), not cookie-based, so
  // a cross-origin page can't attach real credentials to a request even with open CORS; the main
  // reason to restrict it is a split (web container + server container on different origins)
  // self-hosted deployment where the admin wants to lock the API down to just their own web UI's
  // origin. `corsAllowedOrigins` (comma-separated) opts into that; unset keeps current behavior.
  app.use(
    cors({
      // Reads the setting fresh on every request (not once at startup) so a change on the
      // Settings page takes effect immediately, same as every other setting in this app.
      origin: (origin, callback) => {
        const corsOrigins = getSetting("corsAllowedOrigins");
        if (!corsOrigins) return callback(null, true); // unset = allow any origin (default)
        const allowed = corsOrigins.split(",").map((o) => o.trim());
        callback(null, !origin || allowed.includes(origin));
      },
    })
  );
  // Correlation id + HTTP metrics — tags every log line made while handling this request (see
  // logger.ts's withReqTag) with a short id also echoed back as X-Request-Id, and records
  // method/route/status/duration into httpMetrics.ts once the response actually finishes (so a
  // slow/hung request doesn't get counted before it's done). Registered before every other
  // middleware/router so it wraps the *entire* request, not just the routers mounted after it.
  app.use((req, res, next) => {
    const reqId = generateRequestId();
    res.setHeader("X-Request-Id", reqId);
    const startedAt = Date.now();
    res.on("finish", () => {
      // A request no route ever matched (a 401 from requireAuth, a router-level 403, a 404) has
      // no req.route — its raw path must not become a metrics key, or any unauthenticated client
      // could grow httpMetrics' never-pruned map one junk URL at a time until the heap runs out.
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : "<unmatched>";
      recordHttpRequest(req.method, route, res.statusCode, Date.now() - startedAt);
    });
    runWithRequestId(reqId, next);
  });
  // `verify` stashes the exact raw request bytes on req.rawBody before JSON-parsing — needed by
  // the Discord interactions webhook (routes/discordInteractions.ts), which must verify an
  // Ed25519 signature over the literal bytes Discord sent; re-serializing the parsed JSON
  // wouldn't byte-for-byte match the original body, so the parsed object alone isn't enough.
  const stashRawBody = (req: any, _res: unknown, buf: Buffer) => {
    req.rawBody = buf;
  };
  // A settings template exported from an instance with the TRaSH custom formats synced runs well
  // past body-parser's 100kb default; the general parser below skips a body already parsed here.
  // Auth runs first so an unauthenticated client can't make the server buffer and parse 10mb.
  app.use(
    "/api/settings/template/import",
    asyncHandler(requireAuth),
    requireAdmin,
    express.json({ limit: "10mb", verify: stashRawBody })
  );
  app.use(express.json({ verify: stashRawBody }));
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
  // automation already does. Admin-only: every tool proxies to the REST API with the instance
  // admin key, so a restricted household session reaching it would be a full privilege escalation.
  app.all("/api/mcp", requireAdmin, asyncHandler(handleMcpRequest));
  // Mounted before mediaRouter/tracksRouter/artworkRouter — those each gate their whole router
  // behind a blanket requireAdmin `.use()` covering all of /api/media/*, which would otherwise
  // reject this route's own request before Express ever got to trying it, since a router-level
  // `.use()` with no path runs for every request reaching that router regardless of whether it
  // has a matching route. This route is deliberately public (see middleware/auth.ts's exemption
  // list) — an <img src>/background-image can't carry the X-Api-Key/X-Session-Token headers those
  // other routers require.
  app.use("/api/media", localArtworkRouter);
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
  app.use("/api/release-profiles", releaseProfilesRouter);
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
  app.use("/api/irc-feeds", ircFeedsRouter);
  app.use("/api/settings/plex-auth", plexAuthRouter);
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
  app.use("/api/remote-path-mappings", remotePathMappingsRouter);
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
