/**
 * The operations of the native OpenAPI document that were written by hand (openapi.ts generates the rest from the
 * registered routes and lays these over their entries). They carry what no route table can know: request and response
 * descriptions, query parameters, the status codes a client should expect. A key here must be a real route
 * ("/media/{id}" is GET/PATCH/DELETE /api/media/:id): tests/openapiCoverage.test.ts fails on an entry no route answers,
 * so renaming or removing a route cannot leave a stale description behind.
 */
export const HAND_WRITTEN_OPERATIONS: Record<string, Record<string, Record<string, any>>> = {
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
        { name: "seasonNumber", in: "query", schema: { type: "integer" } },
        { name: "detail", in: "query", description: "1: answer {results, indexers} instead of the bare array; indexers says which indexers answered", schema: { type: "string", enum: ["1"] } },
      ],
      responses: {
        "200": {
          description:
            "Annotated search results in the order an automatic search would choose from (serverRank): quality, format score, blocklist status, age, group, packaging, and rejections [{code, reason, type: permanent|temporary}] with approved/rejected flags; alternates are the same release on other indexers",
        },
      },
    },
  },
  "/search/{mediaItemId}/grab": {
    post: {
      summary: "Manually grab a specific search result for this media item",
      description:
        "Body: downloadUrl, title, protocol, indexerId, episodeId/subItemId/seasonNumber, alternates (other links tried in turn when the client refuses the release), force (overrides the blocklist, the identity gate and the already-queued check) and overrides (rejection codes the caller accepted; recorded as a forced grab).",
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
  "/notifications/connections": {
    get: { summary: "List notification connections (secrets show as ********)", responses: { "200": { description: "OK" } } },
    post: {
      summary: "Add a notification connection",
      description:
        "Body: name, kind (discord, slack, webhook, telegram, pushover, ntfy, gotify, matrix, twilio, email, customScript, webPush), config (the kind's fields; GET /notifications/connections/meta lists them), events (names, or omit for the defaults), tagIds, enabled. A webhook takes url, method (POST or PUT), headers, username/password and payloadStyle (aonarr or starr).",
      responses: { "201": { description: "Created" }, "400": { description: "Unknown kind, a missing required field or a bad value, with the reason" } },
    },
  },
  "/notifications/connections/meta": {
    get: { summary: "The kinds and their fields, the events, and each message template with its default and tokens", responses: { "200": { description: "OK" } } },
  },
  "/notifications/connections/{id}": {
    put: {
      summary: "Edit a notification connection (a secret sent back as ******** keeps the stored value)",
      responses: { "200": { description: "OK" } },
    },
    delete: { summary: "Delete a notification connection", responses: { "204": { description: "Deleted" } } },
  },
  "/notifications/connections/{id}/test": {
    post: { summary: "Send the test message to this connection, whatever its events say", responses: { "200": { description: "{ ok } or { ok: false, error }, without any secret or full URL" } } },
  },
  "/quality-profiles": {
    get: {
      summary: "List quality profiles (allowedQualities, cutoff, qualityGroups, qualityOrder: the order the profile ranks the quality ladder in, worst to best, or null for the global order of /qualities)",
      responses: { "200": { description: "OK" } },
    },
    post: {
      summary:
        "Create a quality profile. qualityOrder (optional, a list of different quality names on the ladder, worst to best) gives the profile its own ranking; every allowed quality it leaves out is put into the stored list by its place on the ladder, and a file of a quality that is not listed ranks where it belongs among the listed ones; null or [] ranks by the global order",
      responses: { "201": { description: "Created" } },
    },
  },
  "/quality-profiles/{id}": {
    patch: {
      summary: "Edit a quality profile. qualityOrder sets, or with null / [] resets, the order the profile ranks the ladder in (completed with the allowed qualities it leaves out); a quality newly allowed is put into an existing order by its place on the ladder when the order is not sent",
      responses: { "200": { description: "OK" } },
    },
  },
  "/root-folders": {
    get: { summary: "List root folders (with live free/total disk space)", responses: { "200": { description: "OK" } } },
    post: { summary: "Add a root folder", responses: { "201": { description: "Created" } } },
  },
  "/root-folders/{id}": {
    patch: {
      summary: "Edit a root folder: name, quota, minimum free space (grabs pause below it), and the defaults for what is added into it (quality profile, metadata profile, monitor choices, tags)",
      responses: { "200": { description: "OK" } },
    },
  },
  "/metadata-profiles": {
    get: { summary: "List metadata profiles (which releases an artist or author lists)", responses: { "200": { description: "OK" } } },
    post: { summary: "Create a metadata profile", responses: { "201": { description: "Created" } } },
  },
  "/metadata-profiles/{id}": {
    put: { summary: "Edit a metadata profile", responses: { "200": { description: "OK" } } },
    delete: { summary: "Delete a metadata profile (refused while a title or root folder uses it)", responses: { "204": { description: "Deleted" } } },
  },
  "/import-lists": {
    get: { summary: "List import lists", responses: { "200": { description: "OK" } } },
    post: {
      summary: "Add an import list, with monitor, monitorNewItems, searchOnAdd, minimumAvailability, cleanLevel and tagIds",
      responses: { "201": { description: "Created" } },
    },
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
};
