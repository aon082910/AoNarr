/**
 * Hand-curated OpenAPI 3.0 spec covering the core resources — not every single route in the app
 * (there are ~40 route files); this documents the ones most useful for scripting against AoNarr
 * directly (media CRUD, search/grab, queue, indexers, download clients, requests, root folders,
 * quality profiles) rather than attempting exhaustive 1:1 coverage of every admin-settings
 * endpoint. Kept as a plain object (not generated from the route files) so it can't silently drift
 * from reality without a human noticing at review time — update it by hand alongside route changes.
 */
export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "AoNarr API",
    version: "0.1.0",
    description:
      "Self-hosted media manager API. Authenticate with either the admin API key (`X-Api-Key` header) " +
      "or a household session token (`X-Session-Token` header, from POST /auth/login). " +
      "This spec covers the core resources; see the server source under src/routes for the complete route list.",
  },
  servers: [{ url: "/api" }],
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: "apiKey", in: "header", name: "X-Api-Key" },
      SessionTokenAuth: { type: "apiKey", in: "header", name: "X-Session-Token" },
    },
  },
  security: [{ ApiKeyAuth: [] }, { SessionTokenAuth: [] }],
  paths: {
    "/health": {
      get: { summary: "Health check", security: [], responses: { "200": { description: "OK" } } },
    },
    "/media": {
      get: {
        summary: "List library items",
        parameters: [
          { name: "type", in: "query", schema: { type: "string" } },
          { name: "tagId", in: "query", schema: { type: "integer" } },
        ],
        responses: { "200": { description: "Array of media items" } },
      },
      post: {
        summary: "Add a media item",
        requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        responses: { "201": { description: "Created" }, "409": { description: "Possible duplicate" } },
      },
    },
    "/media/{id}": {
      get: { summary: "Get one media item with children (episodes/sub-items)", responses: { "200": { description: "OK" } } },
      patch: { summary: "Update a media item (monitored, quality profile, root folder, ...)", responses: { "200": { description: "OK" } } },
      delete: { summary: "Remove a media item from the library", responses: { "204": { description: "Deleted" } } },
    },
    "/media/export.csv": {
      get: { summary: "Download the library as CSV", parameters: [{ name: "type", in: "query", schema: { type: "string" } }], responses: { "200": { description: "CSV file" } } },
    },
    "/media/{id}/season/{seasonNumber}/monitor": {
      patch: { summary: "Bulk monitor/unmonitor every episode in one season", responses: { "200": { description: "Updated episodes" } } },
    },
    "/search/{mediaItemId}": {
      get: {
        summary: "Manual search: live indexer search for one media item, episode, or sub-item",
        parameters: [
          { name: "mediaItemId", in: "path", required: true, schema: { type: "integer" } },
          { name: "episodeId", in: "query", schema: { type: "integer" } },
          { name: "subItemId", in: "query", schema: { type: "integer" } },
        ],
        responses: { "200": { description: "Annotated search results (quality, format score, blocklist status)" } },
      },
    },
    "/search/{mediaItemId}/grab": {
      post: {
        summary: "Manually grab a specific search result for this media item",
        parameters: [{ name: "mediaItemId", in: "path", required: true, schema: { type: "integer" } }],
        responses: { "201": { description: "Queue item created" } },
      },
    },
    "/search/bulk": {
      post: { summary: "Search-and-grab the best release for a list of targets", responses: { "200": { description: "Results per target" } } },
    },
    "/activity/queue": {
      get: { summary: "Current download queue", responses: { "200": { description: "Queue items" } } },
    },
    "/indexers": {
      get: { summary: "List indexers", responses: { "200": { description: "OK" } } },
      post: { summary: "Add an indexer (torznab/newznab/rss/ddl)", responses: { "201": { description: "Created" } } },
    },
    "/indexers/{id}": {
      patch: { summary: "Update an indexer", responses: { "200": { description: "OK" } } },
      delete: { summary: "Remove an indexer", responses: { "204": { description: "Deleted" } } },
    },
    "/indexers/{id}/test": {
      post: { summary: "Test an indexer with a sample search", responses: { "200": { description: "{ ok, resultCount | error }" } } },
    },
    "/download-clients": {
      get: { summary: "List download clients", responses: { "200": { description: "OK" } } },
      post: { summary: "Add a download client", responses: { "201": { description: "Created" } } },
    },
    "/quality-profiles": {
      get: { summary: "List quality profiles", responses: { "200": { description: "OK" } } },
      post: { summary: "Create a quality profile", responses: { "201": { description: "Created" } } },
    },
    "/root-folders": {
      get: { summary: "List root folders (with live free/total disk space)", responses: { "200": { description: "OK" } } },
      post: { summary: "Add a root folder", responses: { "201": { description: "Created" } } },
    },
    "/requests": {
      get: { summary: "List requests (own, or all for admins)", responses: { "200": { description: "OK" } } },
      post: { summary: "Submit a request (household users only)", responses: { "201": { description: "Created" } } },
    },
    "/requests/{id}/approve": {
      post: { summary: "Approve a request, creating the library entry (admin only)", responses: { "200": { description: "OK" } } },
    },
    "/requests/{id}/reject": {
      post: { summary: "Reject a request (admin only)", responses: { "200": { description: "OK" } } },
    },
    "/requests/stats": {
      get: { summary: "Per-user request counts, approval rate, and storage (admin only)", responses: { "200": { description: "OK" } } },
    },
    "/users": {
      get: { summary: "List household user accounts (admin only)", responses: { "200": { description: "OK" } } },
      post: { summary: "Create a household user account (admin only)", responses: { "201": { description: "Created" } } },
    },
    "/dashboard/recently-added": {
      get: { summary: "Most recently added library items", responses: { "200": { description: "OK" } } },
    },
    "/dashboard/recently-watched": {
      get: { summary: "Most recently watched library items", responses: { "200": { description: "OK" } } },
    },
    "/wanted/missing": {
      get: { summary: "Everything monitored with no file yet", responses: { "200": { description: "OK" } } },
    },
    "/wanted/calendar": {
      get: {
        summary: "Upcoming episode/album/book release dates in a date range",
        parameters: [
          { name: "start", in: "query", required: true, schema: { type: "string", format: "date" } },
          { name: "end", in: "query", required: true, schema: { type: "string", format: "date" } },
        ],
        responses: { "200": { description: "OK" } },
      },
    },
    "/system/status": {
      get: { summary: "Version, library counts, queue size, disk space", responses: { "200": { description: "OK" } } },
    },
    "/system/health": {
      get: { summary: "Indexer reachability, stuck queue items, pending requests", responses: { "200": { description: "OK" } } },
    },
    "/metrics": {
      get: { summary: "Prometheus text-exposition metrics", security: [], responses: { "200": { description: "OK" } } },
    },
  },
};
