import type { Express } from "express";
import { isOpenApiPath } from "./middleware/auth.js";
import { appUrlBase } from "./services/urlBase.js";
import { HAND_WRITTEN_OPERATIONS } from "./openapiHand.js";
import { walkRoutes, type RouteEntry, type RouteMethod, type RouteWalk } from "./openapiRoutes.js";
import { STARR_APP_KEYS } from "./starr/apps.js";

/**
 * The OpenAPI 3.0 document of the native API (GET /api/openapi.json), generated from the routes the app has registered
 * (openapiRoutes.ts), so a route cannot exist without an entry. Each route gets a skeleton: method, path, parameters,
 * who may call it, the shape of an error. The operations in openapiHand.ts (the core resources, with notes on request
 * and response written by hand) are laid over their skeleton. tests/openapiCoverage.test.ts fails when the two drift.
 * The Starr mounts (/sonarr and the others) have documents of their own (starr/openapi.ts).
 */

type Json = Record<string, any>;

const API_PREFIX = "/api";
const METHOD_ORDER: RouteMethod[] = ["get", "post", "put", "patch", "delete"];
/** Methods that take a JSON body. */
const BODY_METHODS = new Set<RouteMethod>(["post", "put", "patch"]);

/** The mounts of the Starr-compatible apps: their routes have documents of their own, so they are not listed here. */
export const STARR_MOUNTS = STARR_APP_KEYS.map((key) => `/${key}`);

/** The routes of the native API: every route the app has registered except the Starr mounts. */
export function nativeRoutes(app: Express): RouteWalk {
  return walkRoutes(app, STARR_MOUNTS);
}

const isParam = (segment: string): boolean => segment.startsWith(":");
const words = (segment: string): string => segment.replace(/[-_.]+/g, " ");
const capitalize = (text: string): string => (text ? text[0].toUpperCase() + text.slice(1) : text);
const pascal = (text: string): string => text.split(/[^A-Za-z0-9]+/).filter(Boolean).map(capitalize).join("");

/** Words that read the same for one and for many. */
const UNCOUNTED = new Set(["series", "news", "metadata", "status", "analysis"]);

/** "profiles" is "profile", "entries" is "entry", "aliases" is "alias"; "status", "series" and "class" stay as they are. */
function singular(phrase: string): string {
  if (UNCOUNTED.has(phrase.split(" ").pop()!) || phrase.endsWith("media")) return phrase;
  if (/movies$/.test(phrase)) return phrase.slice(0, -1);
  if (/ies$/.test(phrase)) return phrase.replace(/ies$/, "y");
  if (/(sses|uses|ases)$/.test(phrase)) return phrase.slice(0, -2);
  if (/(ss|us|is)$/.test(phrase) || !/s$/.test(phrase)) return phrase;
  return phrase.slice(0, -1);
}

/** Whether a path word names a collection ("media" does, a file name such as "calendar.ics" does not). */
function isPlural(segment: string): boolean {
  const phrase = words(segment);
  if (phrase === "media") return true;
  return !segment.includes(".") && !UNCOUNTED.has(phrase.split(" ").pop()!) && /s$/.test(phrase) && !/(ss|us|is)$/.test(phrase);
}

/** Words that name something done to a thing: "POST /indexers/{id}/test" is "Test indexer {id}". */
const ACTIONS = new Set([
  "add", "apply", "approve", "cancel", "check", "clear", "convert", "dismiss", "download", "enable", "disable", "export", "fetch",
  "grab", "identify", "import", "map", "merge", "move", "pause", "preview", "purge", "refresh", "regenerate", "register", "reject",
  "remove", "rename", "reorder", "rematch", "reset", "resolve", "restore", "resume", "retag", "retry", "run", "scan", "search",
  "select", "send", "share", "split", "start", "stop", "sync", "test", "unsubscribe", "subscribe", "validate", "verify", "write",
]);

/** A path as words, a parameter as "{name}" and a resource just before a parameter in the singular: ["indexers", ":id"] is "indexer {id}". */
function describePath(segments: string[]): string {
  return segments
    .map((segment, i) => {
      if (isParam(segment)) return `{${segment.slice(1)}}`;
      const phrase = words(segment);
      return segments[i + 1] !== undefined && isParam(segments[i + 1]) ? singular(phrase) : phrase;
    })
    .join(" ");
}

/** A short human text from the method and the path ("List media", "Get media {id}", "Test indexer {id}"). */
export function summaryFor(method: RouteMethod, segments: string[]): string {
  if (segments.length === 0) return method === "get" ? "API root" : `${capitalize(method)} API root`;
  const last = segments[segments.length - 1];
  const lastIsParam = isParam(last);
  const lastWords = words(last);
  const before = segments.slice(0, -1);
  switch (method) {
    case "get":
      return `${!lastIsParam && isPlural(last) ? "List" : "Get"} ${describePath(segments)}`;
    case "put":
    case "patch":
      return `Update ${describePath(segments)}`;
    case "delete":
      return `Delete ${describePath(segments)}`;
    case "post": {
      if (lastIsParam) return `Post ${describePath(segments)}`;
      const target = describePath(before);
      const phrase = lastWords.split(" ");
      // "test", "approve" and "scan-import" name what is done to the thing before them.
      if (ACTIONS.has(phrase[0])) return `${capitalize(lastWords)}${phrase.length > 1 && target ? " for" : ""}${target ? ` ${target}` : ""}`;
      if (before.length === 0) return isPlural(last) ? `Create ${singular(lastWords)}` : `Post ${lastWords}`;
      // A plural names what is added to the thing (to a collection under an {id}) or what is created.
      if (isPlural(last)) return isParam(before[before.length - 1]) ? `Add ${singular(lastWords)} to ${target}` : `Create ${describePath([...before, singular(last)])}`;
      return isParam(before[before.length - 1]) ? `Post ${target} ${lastWords}` : capitalize(describePath(segments));
    }
  }
}

/** A stable name for the operation: "getMediaById", "postIndexersByIdTest". */
export function operationIdFor(method: RouteMethod, segments: string[]): string {
  return method + segments.map((segment) => (isParam(segment) ? `By${pascal(segment.slice(1))}` : pascal(segment))).join("");
}

/** A path parameter is an integer when it is a row id by name (":id", ":episodeId", ":seasonNumber"); the rest (tokens, keys, names, kinds) are text. */
function parameterSchema(name: string): Json {
  return /^(id|.+Id|.+Number)$/.test(name) ? { type: "integer" } : { type: "string" };
}

const ERROR_BODY = (schema: string): Json => ({ "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } });
const refResponse = (name: string): Json => ({ $ref: `#/components/responses/${name}` });

/** The shape of every refusal and failure the server answers with, so it can be documented once. */
const COMMON_COMPONENTS = {
  schemas: {
    Error: { type: "object", required: ["error"], properties: { error: { type: "string" } } },
    RateLimited: {
      type: "object",
      required: ["error"],
      properties: { error: { type: "string" }, retryAfterSeconds: { type: "integer", description: "How long the address stays locked out" } },
    },
  },
  responses: {
    Unauthorized: { description: "Missing or invalid credentials (X-Api-Key or X-Session-Token)", content: ERROR_BODY("Error") },
    Forbidden: { description: "Admin access required", content: ERROR_BODY("Error") },
    TooManyRequests: { description: "Too many failed authentication attempts from this address; try again after retryAfterSeconds", content: ERROR_BODY("RateLimited") },
    Failure: { description: "Any other error: the request was refused or failed, with the reason", content: ERROR_BODY("Error") },
  },
};

/** "/media/{id}/season/{n}": the shape two spellings of one path share, whatever the parameters are called. */
const shapeOf = (template: string): string => template.replace(/\{[^}]+\}/g, "{}");

/** The group an operation is listed under: the first part of its path, without a file extension ("calendar.ics" is "calendar"). */
function tagFor(segments: string[]): string {
  const first = segments[0];
  return first && !isParam(first) ? first.replace(/\.[A-Za-z0-9]+$/, "") : "root";
}

function generatedOperation(route: RouteEntry, segments: string[], outside: boolean, taken: Set<string>, urlBase: string): Json {
  const params = segments.filter(isParam).map((s) => s.slice(1));
  // Routes under /api are behind the credential check except the paths it lets through; a route outside /api never meets it.
  const open = outside || isOpenApiPath(route.method.toUpperCase(), `/${segments.map((s) => (isParam(s) ? "1" : s)).join("/")}`);
  let operationId = operationIdFor(route.method, segments);
  for (let n = 2; taken.has(operationId); n++) operationId = `${operationIdFor(route.method, segments)}_${n}`;
  taken.add(operationId);

  const responses: Json = { "200": { description: "OK" } };
  if (!open) {
    responses["401"] = refResponse("Unauthorized");
    responses["429"] = refResponse("TooManyRequests");
  }
  if (route.admin) responses["403"] = refResponse("Forbidden");
  responses.default = refResponse("Failure");

  return {
    operationId,
    tags: [tagFor(segments)],
    summary: summaryFor(route.method, segments),
    ...(route.admin ? { description: "Admin only: the admin API key or an administrator's session.", "x-aonarr-admin-only": true } : {}),
    ...(params.length > 0 ? { parameters: params.map((name) => ({ name, in: "path", required: true, schema: parameterSchema(name) })) } : {}),
    ...(BODY_METHODS.has(route.method) ? { requestBody: { required: false, content: { "application/json": { schema: { type: "object" } } } } } : {}),
    responses,
    ...(open ? { security: [] } : {}),
    ...(outside ? { "x-aonarr-outside-api": true, servers: [{ url: urlBase || "/" }] } : {}),
  };
}

/** The hand-written parts of an operation win over the generated skeleton; the skeleton fills in what they leave out. */
function overlay(generated: Json, hand: Json): Json {
  const merged: Json = { ...generated, ...hand };
  const handParameters: Json[] = hand.parameters ?? [];
  const parameters = [...handParameters, ...(generated.parameters ?? []).filter((g: Json) => !handParameters.some((h) => h.name === g.name && h.in === g.in))];
  if (parameters.length > 0) merged.parameters = parameters;
  const handResponses: Json = hand.responses ?? {};
  // The skeleton's plain 200 would sit beside the 201 or 204 the hand-written entry names.
  const handSucceeds = Object.keys(handResponses).some((code) => /^2\d\d$/.test(code));
  const skeleton: Json = { ...generated.responses };
  if (handSucceeds) delete skeleton["200"];
  merged.responses = { ...skeleton, ...handResponses };
  return merged;
}

/**
 * The document for the routes the app has now. Pass the URL base the instance is served under: nginx cuts it off before
 * a request reaches the server, but Swagger's "Try it out" is sent by the browser and needs it.
 */
export function buildOpenApiDocument(app: Express, urlBase = ""): Json {
  const { routes } = nativeRoutes(app);
  const hand = new Map<string, { path: string; operations: Record<string, Json> }>();
  for (const [path, operations] of Object.entries(HAND_WRITTEN_OPERATIONS)) hand.set(shapeOf(path), { path, operations });

  const operationIds = new Set<string>();
  const paths: Record<string, Record<string, Json>> = {};
  const tags = new Set<string>();
  const ordered = [...routes].sort((a, b) => a.path.localeCompare(b.path) || METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method));
  for (const route of ordered) {
    const outside = !(route.path === API_PREFIX || route.path.startsWith(`${API_PREFIX}/`));
    const relative = outside ? route.path : route.path.slice(API_PREFIX.length) || "/";
    const segments = relative.split("/").filter(Boolean);
    const template = `/${segments.map((s) => (isParam(s) ? `{${s.slice(1)}}` : s)).join("/")}`;
    let operation = generatedOperation(route, segments, outside, operationIds, urlBase);
    const written = hand.get(shapeOf(template));
    // A hand-written entry whose parameters are named differently from the route's would describe a path it does not match.
    if (!outside && written && written.path === template && written.operations[route.method]) operation = overlay(operation, written.operations[route.method]);
    (paths[template] ??= {})[route.method] = operation;
    tags.add(operation.tags[0]);
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "AoNarr API",
      version: "0.1.0",
      description:
        "Self-hosted media manager API. Authenticate with either the admin API key (`X-Api-Key` header) " +
        "or a household session token (`X-Session-Token` header, from POST /auth/login). " +
        "Every route the server answers under /api is listed here, grouped by the first part of its path. The core resources " +
        "(media, search and grab, the queue, indexers, download clients, requests, root folders, quality profiles) carry notes " +
        "on request and response; the other operations give the method, path, path parameters, whether the call needs an " +
        "administrator (`x-aonarr-admin-only`) or no credential, and the shape of an error.",
    },
    servers: [{ url: `${urlBase}${API_PREFIX}` }],
    tags: [...tags].sort().map((name) => ({ name })),
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: "apiKey", in: "header", name: "X-Api-Key" },
        SessionTokenAuth: { type: "apiKey", in: "header", name: "X-Session-Token" },
      },
      ...COMMON_COMPONENTS,
    },
    security: [{ ApiKeyAuth: [] }, { SessionTokenAuth: [] }],
    paths,
  };
}

const documents = new WeakMap<Express, Map<string, Json>>();

/** The document for this app, built once per URL base: the routers do not change after start-up. */
export function openApiDocument(app: Express): Json {
  const base = appUrlBase();
  let byBase = documents.get(app);
  if (!byBase) documents.set(app, (byBase = new Map()));
  let document = byBase.get(base);
  if (!document) byBase.set(base, (document = buildOpenApiDocument(app, base)));
  return document;
}

/** "METHOD /path" of every hand-written operation that no registered route answers: a description left behind by a route that was renamed or removed. */
export function staleHandWrittenOperations(app: Express): string[] {
  const { routes } = nativeRoutes(app);
  const live = new Set(
    routes
      .filter((r) => r.path.startsWith(`${API_PREFIX}/`))
      .map((r) => `${r.method} ${r.path.slice(API_PREFIX.length).replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`)
  );
  const stale: string[] = [];
  for (const [path, operations] of Object.entries(HAND_WRITTEN_OPERATIONS)) {
    for (const method of Object.keys(operations)) if (!live.has(`${method} ${path}`)) stale.push(`${method.toUpperCase()} ${path}`);
  }
  return stale;
}
