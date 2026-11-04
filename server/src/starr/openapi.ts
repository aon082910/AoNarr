import type { StarrApp } from "./apps.js";
import { STARR_ROUTE_DOCS } from "./routeDocs.js";

/**
 * The OpenAPI document of one virtual app, built from the routes it registered (so a route cannot exist without an entry),
 * served at <mount>/api/<version>/openapi.json. The native /api document is still the hand-written one.
 */
export function starrOpenApi(app: StarrApp) {
  const paths: Record<string, Record<string, unknown>> = {
    "/ping": { get: { summary: "Is the server there (no key needed)", security: [], responses: { "200": { description: "{ status: OK }" } } } },
  };
  for (const doc of STARR_ROUTE_DOCS.values()) {
    if (!doc.apps.has(app.key)) continue;
    const path = `/api/${app.apiVersion}${doc.path.replace(/:([A-Za-z]+)/g, "{$1}")}`;
    const parameters = [...doc.path.matchAll(/:([A-Za-z]+)/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "integer" } }));
    paths[path] ??= {};
    paths[path][doc.method] = {
      summary: doc.summary,
      parameters,
      ...(doc.method === "post" || doc.method === "put" ? { requestBody: { content: { "application/json": { schema: { type: "object" } } } } } : {}),
      responses: { "200": { description: "OK" }, "400": { description: "Validation failed" }, "401": { description: "Missing or wrong API key" }, "404": { description: "NotFound" } },
    };
  }
  return {
    openapi: "3.0.3",
    info: {
      title: `AoNarr as ${app.appName}`,
      version: app.claimedVersion,
      description:
        `The part of ${app.appName}'s API that AoNarr answers (the endpoints Prowlarr, Overseerr, Bazarr, Homepage, Unpackerr and similar tools use). ` +
        `Set the tool's URL base to /${app.key} and its API key to AoNarr's. The key may be sent as X-Api-Key, as the apikey query parameter or as a Bearer token.`,
    },
    servers: [{ url: `/${app.key}` }],
    components: {
      securitySchemes: {
        ApiKeyHeader: { type: "apiKey", in: "header", name: "X-Api-Key" },
        ApiKeyQuery: { type: "apiKey", in: "query", name: "apikey" },
        Bearer: { type: "http", scheme: "bearer" },
      },
    },
    security: [{ ApiKeyHeader: [] }, { ApiKeyQuery: [] }, { Bearer: [] }],
    paths,
  };
}
