import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import express, { Router, type Express } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupTestDb } from "./helpers/testDb.js";

/**
 * The native OpenAPI document is generated from the routes the app registers (src/openapi.ts, src/openapiRoutes.ts), so a
 * route cannot exist without an entry; this file is what stops the document and the routes from drifting apart:
 *  - tests/fixtures/openapi-routes.txt lists every route with whether it is admin-only or open. A new route, a removed
 *    one, or a route that gained or lost its admin guard shows up as a diff that has to be looked at and accepted.
 *  - a count of the route registrations in the source files must not exceed what the router walk found.
 *  - every hand-written description (src/openapiHand.ts) must belong to a real route.
 *  - the document is checked for being valid OpenAPI 3 (references resolve, ids unique, path parameters declared).
 *  - the admin and no-credential marks are checked against what the server really answers.
 */

let app: Express;
let apiKey: string;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let openapi: typeof import("../src/openapi.js");
let routesModule: typeof import("../src/openapiRoutes.js");
let requireAdmin: (typeof import("../src/middleware/auth.js"))["requireAdmin"];
let doc: any;

const FIXTURE = fileURLToPath(new URL("./fixtures/openapi-routes.txt", import.meta.url));
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const METHODS = ["get", "post", "put", "patch", "delete"];

beforeAll(async () => {
  ({ app, apiKey, db } = await setupTestDb());
  openapi = await import("../src/openapi.js");
  routesModule = await import("../src/openapiRoutes.js");
  ({ requireAdmin } = await import("../src/middleware/auth.js"));
  doc = openapi.openApiDocument(app);
});

/** "METHOD /api/path/{id}" and the marks, one line per operation, in a fixed order. */
function routeLines(document: any): string[] {
  const prefix = document.servers[0].url.replace(/\/api$/, "") + "/api";
  const lines: string[] = [];
  for (const [p, item] of Object.entries<any>(document.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const mark = op["x-aonarr-admin-only"] ? "  [admin]" : op.security?.length === 0 ? "  [open]" : "";
      lines.push(`${method.toUpperCase()} ${prefix}${p}${mark}`);
    }
  }
  return lines.sort();
}

/** A structural check of an OpenAPI 3.0 document: what a client generator trips over. Returns the problems found. */
function validateOpenApi(document: any): string[] {
  const problems: string[] = [];
  if (!/^3\.0\.\d+$/.test(document.openapi ?? "")) problems.push(`openapi is "${document.openapi}", not 3.0.x`);
  if (!document.info?.title || !document.info?.version) problems.push("info needs a title and a version");
  if (!Array.isArray(document.servers) || document.servers.length === 0) problems.push("servers is empty");
  if (!document.paths || typeof document.paths !== "object") return [...problems, "paths is missing"];

  const resolves = (ref: string): boolean => {
    if (!ref.startsWith("#/")) return false;
    let node: any = document;
    for (const part of ref.slice(2).split("/")) {
      node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
      if (node === undefined) return false;
    }
    return true;
  };
  const walkRefs = (node: unknown, where: string): void => {
    if (Array.isArray(node)) node.forEach((n, i) => walkRefs(n, `${where}[${i}]`));
    else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref" && typeof value === "string") {
          if (!resolves(value)) problems.push(`${where}: $ref ${value} does not resolve`);
        } else walkRefs(value, `${where}.${key}`);
      }
    }
  };
  walkRefs(document, "#");

  const tagNames = new Set<string>((document.tags ?? []).map((t: any) => t.name));
  const schemes = new Set(Object.keys(document.components?.securitySchemes ?? {}));
  const operationIds = new Map<string, string>();
  for (const [p, item] of Object.entries<any>(document.paths)) {
    if (!p.startsWith("/") || /[?#]/.test(p)) problems.push(`${p}: not a path template`);
    const inTemplate = [...p.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    if (new Set(inTemplate).size !== inTemplate.length) problems.push(`${p}: a parameter name is used twice`);
    for (const [method, op] of Object.entries<any>(item)) {
      const where = `${method.toUpperCase()} ${p}`;
      if (!METHODS.includes(method)) {
        problems.push(`${where}: not an HTTP method this API uses`);
        continue;
      }
      if (typeof op.operationId !== "string" || !op.operationId) problems.push(`${where}: no operationId`);
      else if (operationIds.has(op.operationId)) problems.push(`${where}: operationId ${op.operationId} is also ${operationIds.get(op.operationId)}`);
      else operationIds.set(op.operationId, where);
      for (const tag of op.tags ?? []) if (!tagNames.has(tag)) problems.push(`${where}: tag ${tag} is not in the document's tags`);
      if (!op.responses || Object.keys(op.responses).length === 0) problems.push(`${where}: no responses`);
      for (const [code, response] of Object.entries<any>(op.responses ?? {})) {
        if (!/^(default|[1-5]\d\d|[1-5]XX)$/.test(code)) problems.push(`${where}: response code ${code}`);
        if (!response.$ref && typeof response.description !== "string") problems.push(`${where}: response ${code} has no description`);
      }
      const parameters: any[] = op.parameters ?? [];
      const seen = new Set<string>();
      for (const parameter of parameters) {
        if (parameter.$ref) continue;
        const key = `${parameter.in}:${parameter.name}`;
        if (seen.has(key)) problems.push(`${where}: parameter ${key} is declared twice`);
        seen.add(key);
        if (parameter.in === "path" && parameter.required !== true) problems.push(`${where}: path parameter ${parameter.name} is not required: true`);
      }
      const declaredPath = parameters.filter((x) => x.in === "path").map((x) => x.name);
      for (const name of inTemplate) if (!declaredPath.includes(name)) problems.push(`${where}: path parameter {${name}} is not declared`);
      for (const name of declaredPath) if (!inTemplate.includes(name)) problems.push(`${where}: parameter ${name} is declared but is not in the path`);
      if ((method === "get" || method === "delete") && op.requestBody) problems.push(`${where}: a request body on ${method}`);
      for (const requirement of op.security ?? []) for (const name of Object.keys(requirement)) if (!schemes.has(name)) problems.push(`${where}: security scheme ${name} is not defined`);
    }
  }
  return problems;
}

/** How many route registrations the source files hold: router.get("..."), fooRouter.post(...), app.all(...). `all` answers five methods. */
function sourceRegistrations(): number {
  const files = [path.join(SRC, "app.ts"), ...fs.readdirSync(path.join(SRC, "routes")).filter((f) => f.endsWith(".ts")).map((f) => path.join(SRC, "routes", f))];
  let count = 0;
  for (const file of files) {
    // Only comments that start a line are cut: a path such as "/files/*" holds a comment opener that is not one.
    const text = fs.readFileSync(file, "utf8").replace(/^\s*\/\*[\s\S]*?\*\//gm, "").replace(/^\s*\/\/.*$/gm, "");
    for (const match of text.matchAll(/\b(?:\w*[rR]outer|app)\.(get|post|put|patch|delete|all)\(\s*["'`]/g)) count += match[1] === "all" ? METHODS.length : 1;
  }
  return count;
}

describe("the native OpenAPI document lists every route", () => {
  it("matches tests/fixtures/openapi-routes.txt (a new, removed or re-guarded route must be accepted there)", () => {
    const actual = routeLines(doc);
    if (process.env.UPDATE_OPENAPI_ROUTES === "1") {
      fs.writeFileSync(FIXTURE, actual.join("\n") + "\n");
      return;
    }
    const expected = fs.readFileSync(FIXTURE, "utf8").replace(/\r\n/g, "\n").split("\n").filter(Boolean);
    const added = actual.filter((line) => !expected.includes(line));
    const removed = expected.filter((line) => !actual.includes(line));
    expect(
      { added, removed },
      `The routes changed. If that is intended, run this test file once with the environment variable UPDATE_OPENAPI_ROUTES=1 ` +
        `(it rewrites server/tests/fixtures/openapi-routes.txt) and commit the new file; a route that gained or lost its [admin] mark deserves a second look first.`
    ).toEqual({ added: [], removed: [] });
  });

  it("walks every route the source files register (a router the walk cannot see would be missed above)", () => {
    const { routes, unclassified } = openapi.nativeRoutes(app);
    expect(routes.length).toBeGreaterThanOrEqual(sourceRegistrations());
    // Something the walk could not read would be left out of the document without a trace.
    expect(unclassified).toEqual([]);
  });

  it("leaves out the Starr mounts and nothing else, and lists no route twice", () => {
    const { skippedMounts, shadowed } = openapi.nativeRoutes(app);
    expect([...skippedMounts].sort()).toEqual([...openapi.STARR_MOUNTS].sort());
    expect(shadowed).toEqual([]);
    expect(Object.keys(doc.paths).filter((p) => /^\/(sonarr|radarr|lidarr|readarr)\b/.test(p))).toEqual([]);
  });

  it("puts every operation under a tag the document lists, with a stable unique operationId and a summary", () => {
    const tags = new Set(doc.tags.map((t: any) => t.name));
    for (const [p, item] of Object.entries<any>(doc.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        expect(tags.has(op.tags?.[0]), `${method} ${p}`).toBe(true);
        expect(typeof op.summary === "string" && op.summary.length > 0, `${method} ${p}`).toBe(true);
      }
    }
  });
});

describe("the hand-written operations", () => {
  it("each belong to a real route", () => {
    expect(openapi.staleHandWrittenOperations(app)).toEqual([]);
  });

  it("win over the generated skeleton, which fills in what they leave out", () => {
    const grab = doc.paths["/search/{mediaItemId}/grab"].post;
    expect(grab.summary).toBe("Manually grab a specific search result for this media item");
    expect(grab.responses["201"].description).toBe("Queue item created");
    // The skeleton's plain 200 is not left beside the 201 the hand-written entry names.
    expect(grab.responses["200"]).toBeUndefined();
    // What the hand-written entry does not say comes from the route: the error shapes, the id, the operation id and the tag.
    expect(grab.responses["401"]).toEqual({ $ref: "#/components/responses/Unauthorized" });
    expect(grab.responses["403"]).toEqual({ $ref: "#/components/responses/Forbidden" });
    expect(grab.parameters).toEqual([{ name: "mediaItemId", in: "path", required: true, schema: { type: "integer" } }]);
    expect(grab.operationId).toBe("postSearchByMediaItemIdGrab");
    expect(grab.tags).toEqual(["search"]);

    // A hand-written query parameter stays, and the path parameter the hand-written entry never declared is added.
    const media = doc.paths["/media/{id}"].get;
    expect(media.summary).toBe("Get one media item with children (episodes/sub-items)");
    expect(media.parameters).toEqual([{ name: "id", in: "path", required: true, schema: { type: "integer" } }]);
    expect(doc.paths["/media"].get.parameters.map((p: any) => p.name)).toEqual(["type", "tagId"]);
    // Open paths keep their empty security list.
    expect(doc.paths["/health"].get.security).toEqual([]);
    expect(doc.paths["/metrics"].get.security).toEqual([]);
  });
});

describe("the document is valid OpenAPI 3", () => {
  it("has no unresolved reference, duplicate id, undeclared path parameter or missing description", () => {
    expect(validateOpenApi(doc)).toEqual([]);
  });

  it("the check itself finds the faults it is there for", () => {
    const broken = JSON.parse(JSON.stringify(doc));
    broken.paths["/media/{id}"].get.parameters = [];
    broken.paths["/tags"].get.operationId = broken.paths["/tags"].post.operationId;
    broken.paths["/tags"].post.responses["401"] = { $ref: "#/components/responses/Nope" };
    delete broken.paths["/indexers"].get.responses["200"].description;
    broken.paths["/indexers"].get.tags = ["not-a-tag"];
    const problems = validateOpenApi(broken).join("\n");
    expect(problems).toContain("path parameter {id} is not declared");
    expect(problems).toContain("is also");
    expect(problems).toContain("does not resolve");
    expect(problems).toContain("has no description");
    expect(problems).toContain("not-a-tag is not in the document's tags");
  });

  it("types the parameters that are row ids as integers and the rest as text", () => {
    expect(doc.paths["/media/{id}"].get.parameters[0].schema).toEqual({ type: "integer" });
    expect(doc.paths["/media/{id}/season/{seasonNumber}/monitor"].patch.parameters.map((p: any) => [p.name, p.schema.type])).toEqual([
      ["id", "integer"],
      ["seasonNumber", "integer"],
    ]);
    expect(doc.paths["/jobs/{key}/run"].post.parameters[0].schema).toEqual({ type: "string" });
    expect(doc.paths["/share/{token}"].get.parameters[0].schema).toEqual({ type: "string" });
  });

  it("documents the error body as { error: string } for the refusals the server really sends", () => {
    expect(doc.components.schemas.Error).toEqual({ type: "object", required: ["error"], properties: { error: { type: "string" } } });
    for (const name of ["Unauthorized", "Forbidden", "TooManyRequests", "Failure"]) {
      expect(doc.components.responses[name].content["application/json"].schema.$ref).toMatch(/^#\/components\/schemas\//);
    }
  });
});

describe("the marks in the document are what the server does", () => {
  let householdToken: string;

  beforeAll(async () => {
    const { createSession, hashPassword } = await import("../src/services/auth.js");
    const userId = Number((await db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('openapi-household', ?, 'user')`).run(hashPassword("x"))).lastInsertRowid);
    householdToken = (await createSession(userId)).token;
  });

  /** A request path from a template: every parameter is filled with something. */
  const concrete = (template: string): string => `/api${template.replace(/\{[^}]+\}/g, "1")}`;

  it("refuses a household account on every operation marked admin-only", async () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const [p, item] of Object.entries<any>(doc.paths)) {
      for (const method of METHODS) {
        if (!item[method]?.["x-aonarr-admin-only"]) continue;
        const res = await (request(app) as any)[method](concrete(p)).set("X-Session-Token", householdToken);
        checked++;
        if (res.status !== 403) wrong.push(`${method.toUpperCase()} ${p} answered ${res.status}`);
      }
    }
    expect(checked).toBeGreaterThan(300);
    expect(wrong).toEqual([]);
  }, 120000);

  it("asks for a credential on every operation that is not marked open", async () => {
    const wrong: string[] = [];
    for (const [p, item] of Object.entries<any>(doc.paths)) {
      for (const method of METHODS) {
        const op = item[method];
        if (!op || op.security?.length === 0) continue;
        const res = await (request(app) as any)[method](concrete(p));
        if (res.status !== 401) wrong.push(`${method.toUpperCase()} ${p} answered ${res.status}`);
      }
    }
    expect(wrong).toEqual([]);
  }, 120000);

  it("lets the paths marked open through the credential check (the same list the check itself reads)", async () => {
    const { isOpenApiPath } = await import("../src/middleware/auth.js");
    expect(isOpenApiPath("POST", "/auth/login")).toBe(true);
    expect(isOpenApiPath("GET", "/share/abc")).toBe(true);
    expect(isOpenApiPath("GET", "/remote-instances/4/local-artwork/abc")).toBe(true);
    expect(isOpenApiPath("POST", "/remote-instances/4/local-artwork/abc")).toBe(false);
    expect(isOpenApiPath("GET", "/media")).toBe(false);
    // Unauthenticated, the open health route answers and a closed one does not.
    expect((await request(app).get("/api/health")).status).toBe(200);
    expect((await request(app).get("/api/tags")).status).toBe(401);
    for (const [p, item] of Object.entries<any>(doc.paths)) {
      for (const method of METHODS) {
        if (item[method]?.security?.length === 0) expect(isOpenApiPath(method.toUpperCase(), concrete(p).slice(4)), `${method} ${p}`).toBe(true);
      }
    }
  });

  it("serves the document to an admin only", async () => {
    const res = await request(app).get("/api/openapi.json").set("X-Api-Key", apiKey);
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.0.3");
    expect(res.body.servers).toEqual([{ url: "/api" }]);
    expect(Object.keys(res.body.paths).length).toBeGreaterThan(300);
    expect((await request(app).get("/api/openapi.json").set("X-Session-Token", householdToken)).status).toBe(403);
    expect((await request(app).get("/api/openapi.json")).status).toBe(401);
  });

  it("carries the URL base in `servers` and builds the document once per base", async () => {
    const fetchServers = async () => (await request(app).get("/api/openapi.json").set("X-Api-Key", apiKey)).body.servers;
    try {
      process.env.URL_BASE = "/aonarr";
      expect(await fetchServers()).toEqual([{ url: "/aonarr/api" }]);
      expect(openapi.openApiDocument(app)).toBe(openapi.openApiDocument(app));
    } finally {
      delete process.env.URL_BASE;
    }
    expect(await fetchServers()).toEqual([{ url: "/api" }]);
    expect(openapi.openApiDocument(app)).toBe(doc);
  });
});

describe("the router walk", () => {
  const handler = (_req: unknown, res: { json: (body: unknown) => void }) => res.json({});

  it("reads mount paths, nested routers and parameters in a mount path", () => {
    const inner = Router();
    inner.get("/", handler);
    inner.get("/:id/parts/:partId", handler);
    const outer = Router();
    outer.use("/things/:thingId", inner);
    const sample = express();
    sample.use("/api/v2", outer);
    sample.get("/api/health", handler);
    const { routes, unclassified } = routesModule.walkRoutes(sample);
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(["get /api/health", "get /api/v2/things/:thingId", "get /api/v2/things/:thingId/:id/parts/:partId"]);
    expect(unclassified).toEqual([]);
  });

  it("lists every method of a router.route() chain and of an array of paths, and answers app.all with five methods", () => {
    const router = Router();
    router.route("/widgets").get(handler).post(handler);
    router.get(["/a", "/b"], handler);
    const sample = express();
    sample.use("/api", router);
    sample.all("/api/any", handler);
    const lines = routesModule.walkRoutes(sample).routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(lines).toEqual(["delete /api/any", "get /api/a", "get /api/any", "get /api/b", "get /api/widgets", "patch /api/any", "post /api/any", "post /api/widgets", "put /api/any"]);
  });

  it("does not guess at a regular-expression route, a wildcard or an optional segment: they are reported", () => {
    const router = Router();
    router.get(/^\/re-.*$/, handler);
    router.get("/files/*", handler);
    router.get("/maybe/:x?", handler);
    router.get("/plain", handler);
    const sample = express();
    sample.use("/api", router);
    const walk = routesModule.walkRoutes(sample);
    expect(walk.routes.map((r) => r.path)).toEqual(["/api/plain"]);
    expect(walk.unclassified).toHaveLength(3);
  });

  it("marks a route admin-only by requireAdmin in its own chain or in a router.use() that runs before it", () => {
    const first = Router();
    first.get("/open-before-guard", handler);
    first.use(requireAdmin);
    first.get("/guarded", handler);
    const second = Router();
    second.get("/later-sibling/:id", handler);
    const third = Router();
    third.get("/own", requireAdmin, handler);
    third.get("/plain", handler);
    const sample = express();
    sample.use("/api/one", first);
    // Mounted under the same prefix after the guard: a request for it meets the guard first.
    sample.use("/api/one", second);
    sample.use("/api/three", third);
    sample.post("/api/guarded-by-app", requireAdmin, handler);
    const admin = Object.fromEntries(routesModule.walkRoutes(sample).routes.map((r) => [`${r.method} ${r.path}`, r.admin]));
    expect(admin).toEqual({
      "get /api/one/open-before-guard": false,
      "get /api/one/guarded": true,
      "get /api/one/later-sibling/:id": true,
      "get /api/three/own": true,
      "get /api/three/plain": false,
      "post /api/guarded-by-app": true,
    });
  });

  it("skips the mounts it is told to and sub-applications, and lists a second registration of a route once", () => {
    const skipped = Router();
    skipped.get("/x", handler);
    const sample = express();
    sample.use("/tools", skipped);
    sample.use("/sub", express().get("/y", handler));
    sample.get("/api/dup", handler);
    sample.get("/api/dup", handler);
    const walk = routesModule.walkRoutes(sample, ["/tools"]);
    expect(walk.routes.map((r) => r.path)).toEqual(["/api/dup"]);
    expect([...walk.skippedMounts].sort()).toEqual(["/sub", "/tools"]);
    expect(walk.shadowed).toEqual(["GET /api/dup"]);
  });

  it("lists a route outside /api with its real path and flags it", async () => {
    const sample = express();
    sample.get("/hooks/incoming/:token", handler);
    sample.get("/api/inside", handler);
    const document = openapi.buildOpenApiDocument(sample, "/aonarr");
    expect(document.servers).toEqual([{ url: "/aonarr/api" }]);
    const outside = document.paths["/hooks/incoming/{token}"].get;
    expect(outside["x-aonarr-outside-api"]).toBe(true);
    expect(outside.servers).toEqual([{ url: "/aonarr" }]);
    expect(document.paths["/inside"].get["x-aonarr-outside-api"]).toBeUndefined();
    expect(validateOpenApi(document)).toEqual([]);
  });
});

describe("summaries and ids", () => {
  const summary = (method: any, p: string) => openapi.summaryFor(method, p.split("/").filter(Boolean));

  it("reads a method and a path as a short phrase", () => {
    expect(summary("get", "/media")).toBe("List media");
    expect(summary("get", "/media/:id")).toBe("Get media {id}");
    expect(summary("get", "/indexers/:id")).toBe("Get indexer {id}");
    expect(summary("get", "/system/status")).toBe("Get system status");
    expect(summary("get", "/calendar.ics")).toBe("Get calendar ics");
    expect(summary("post", "/indexers")).toBe("Create indexer");
    expect(summary("post", "/starr-import/movies")).toBe("Create starr import movie");
    expect(summary("post", "/indexers/:id/test")).toBe("Test indexer {id}");
    expect(summary("post", "/media/:id/rename-files")).toBe("Rename files for media {id}");
    expect(summary("post", "/media/:id/aliases")).toBe("Add alias to media {id}");
    expect(summary("post", "/auth/login")).toBe("Auth login");
    expect(summary("patch", "/tags/:id")).toBe("Update tag {id}");
    expect(summary("delete", "/media/:id/tags/:tagId")).toBe("Delete media {id} tag {tagId}");
  });

  it("derives an operation id from the method and the path", () => {
    expect(openapi.operationIdFor("get", ["media", ":id"])).toBe("getMediaById");
    expect(openapi.operationIdFor("post", ["indexers", ":id", "test"])).toBe("postIndexersByIdTest");
    expect(openapi.operationIdFor("get", ["media", "export.csv"])).toBe("getMediaExportCsv");
  });
});
