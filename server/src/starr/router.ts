import express, { Router, type Application, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { requireAdmin, requireAuthStrict } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errorHandler.js";
import { log } from "../services/logger.js";
import { STARR_APPS, STARR_APP_KEYS, type StarrApp } from "./apps.js";
import { registerSystemRoutes } from "./systemRoutes.js";
import { registerIndexerRoutes } from "./indexerRoutes.js";
import { registerActivityRoutes } from "./activityRoutes.js";
import { registerLibraryRoutes } from "./libraryRoutes.js";
import { registerMusicBookRoutes } from "./musicBookRoutes.js";
import { registerReleasePushRoutes } from "./releasePush.js";
import { registerCommandRoutes } from "./commandRoutes.js";
import { starrOpenApi } from "./openapi.js";
import { STARR_ROUTE_DOCS, type RouteDoc } from "./routeDocs.js";

export type StarrHandler = (req: Request, res: Response, app: StarrApp) => Promise<unknown> | unknown;

/** Registers routes of one virtual app and records them for the OpenAPI document. */
export class StarrRoutes {
  constructor(
    readonly app: StarrApp,
    private readonly router: Router
  ) {}

  private add(method: RouteDoc["method"], path: string, summary: string, handler: StarrHandler, status = 200): void {
    const id = `${method} ${path}`;
    const doc = STARR_ROUTE_DOCS.get(id) ?? { method, path, summary, apps: new Set<string>() };
    doc.apps.add(this.app.key);
    STARR_ROUTE_DOCS.set(id, doc);
    this.router[method](
      path,
      asyncHandler(async (req, res) => {
        const body = await handler(req, res, this.app);
        if (res.headersSent) return;
        if (body === undefined) {
          res.status(204).end();
          return;
        }
        res.status(status).json(body);
      })
    );
  }

  get(path: string, summary: string, handler: StarrHandler): void {
    this.add("get", path, summary, handler);
  }
  post(path: string, summary: string, handler: StarrHandler, status = 201): void {
    this.add("post", path, summary, handler, status);
  }
  put(path: string, summary: string, handler: StarrHandler): void {
    this.add("put", path, summary, handler);
  }
  delete(path: string, summary: string, handler: StarrHandler): void {
    this.add("delete", path, summary, handler);
  }
}

/** The key may come in the `X-Api-Key` header, the `apikey` query parameter or a Bearer token, as a Starr app takes it. */
export function starrCredentials(req: Request, res: Response, next: NextFunction): void {
  // The auth middleware answers { error }; a Starr app answers { message }.
  const json = res.json.bind(res);
  res.json = (body?: any) => json(body && typeof body === "object" && !Array.isArray(body) && typeof body.error === "string" && body.message === undefined ? { message: body.error, ...body } : body);
  if (!req.header("x-api-key")) {
    const query = typeof req.query.apikey === "string" ? req.query.apikey : "";
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.header("authorization") ?? "")?.[1] ?? "";
    const key = query || bearer;
    if (key) req.headers["x-api-key"] = key;
  }
  next();
}

function versionHeader(app: StarrApp): RequestHandler {
  return (_req, res, next) => {
    res.setHeader("X-Application-Version", app.claimedVersion);
    next();
  };
}

/** Starr answers an error as { message }, and a failed validation as a list of { propertyName, errorMessage }. */
function starrErrors(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof HttpError) {
    const body = (err as HttpError & { body?: unknown }).body;
    res.status(err.status).json(err.status === 400 && Array.isArray((err as { validation?: unknown }).validation) ? (err as { validation?: unknown }).validation : { message: err.message, ...(body && typeof body === "object" && !Array.isArray(body) && "duplicates" in body ? { duplicates: (body as { duplicates: unknown }).duplicates } : {}) });
    return;
  }
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 500 && (err as { expose?: unknown }).expose === true) {
    res.status(status).json({ message: (err as Error).message });
    return;
  }
  log.error(err instanceof Error ? err : String(err));
  res.status(500).json({ message: "Internal server error" });
}

function buildApp(app: StarrApp): Router {
  const root = Router();
  const api = Router();
  const routes = new StarrRoutes(app, api);

  root.use(versionHeader(app));
  // Open, as in a Starr app: tools use it to see whether the server is there.
  root.get("/ping", (_req, res) => res.json({ status: "OK" }));
  root.head("/ping", (_req, res) => res.status(200).end());

  root.use("/api", starrCredentials, asyncHandler(requireAuthStrict), requireAdmin);
  root.get("/api", (_req, res) => res.json({ current: app.apiVersion, deprecated: [] }));

  registerSystemRoutes(routes);
  registerIndexerRoutes(routes);
  registerActivityRoutes(routes);
  // Before the library routes: their `/artist/:id` would take "lookup" for an id.
  registerMusicBookRoutes(routes);
  registerLibraryRoutes(routes);
  registerCommandRoutes(routes);
  registerReleasePushRoutes(routes);
  api.get("/openapi.json", (_req, res) => {
    res.json(starrOpenApi(app));
  });

  api.use((_req, res) => {
    res.status(404).json({ message: "NotFound" });
  });
  root.use(`/api/${app.apiVersion}`, express.Router().use(api));
  root.use(starrErrors);
  return root;
}

/**
 * Mounts a virtual Sonarr, Radarr, Lidarr and Readarr at /sonarr, /radarr, /lidarr and /readarr. Their paths are the real
 * apps' (`/sonarr/api/v3/queue`), so a tool's URL base is `/sonarr` and its key is the instance API key.
 */
export function mountStarrApps(server: Application): void {
  for (const key of STARR_APP_KEYS) server.use(`/${key}`, buildApp(STARR_APPS[key]));
}
