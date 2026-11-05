import type { Express } from "express";
import { requireAdmin } from "./middleware/auth.js";

/**
 * Walks the routers an Express 4 app has registered and lists every route with its real, full path: the table the
 * native OpenAPI document (openapi.ts) is generated from, so a route cannot exist without an entry.
 *
 * Express keeps no record of the path a router was mounted at, only the regular expression it made from it, so the
 * mount path is read back out of that expression. Anything the walk cannot read with certainty (a regular-expression
 * route, a wildcard, an optional segment, a mount path that is a pattern) goes to `unclassified` instead of being
 * guessed at, and the coverage test (tests/openapiCoverage.test.ts) fails while that list is not empty.
 */

export type RouteMethod = "get" | "post" | "put" | "patch" | "delete";

export interface RouteEntry {
  method: RouteMethod;
  /** Express style, the whole path from the app root: "/api/media/:id". */
  path: string;
  /** An admin is needed: requireAdmin sits in the route's own chain or in a router.use() that runs before it. */
  admin: boolean;
}

export interface RouteWalk {
  routes: RouteEntry[];
  /** "METHOD /path" of a second registration of a route that is already listed: the first one answers, so it is not listed twice. */
  shadowed: string[];
  /** Mount points the walk did not enter: the ones it was told to skip (the Starr mounts, which have documents of their own) and whole sub-applications. */
  skippedMounts: string[];
  /** What the walk could not read, as text. */
  unclassified: string[];
}

const METHODS: RouteMethod[] = ["get", "post", "put", "patch", "delete"];

/** What path-to-regexp 0.1 (Express 4) makes of "/api/users" used as a mount: the path, an optional slash, then "end of segment". */
const MOUNT_TAIL = "\\/?(?=\\/|$)";
/** What it makes of "/:name" in the middle of a path: a group with the slash inside it (or just before it, in other versions), and "[^/]" written with or without the backslash. */
const PARAM_GROUP = /(?:\\\/)?\(\?:(?:\\\/)?\(\[\^\\?\/\]\+\?\)\)/g;

interface Layer {
  name?: string;
  handle?: { stack?: Layer[] };
  regexp?: RegExp & { fast_slash?: boolean };
  keys?: { name: string | number }[];
  route?: { path: unknown; stack: (Layer & { method?: string })[]; methods: Record<string, boolean> };
  method?: string;
}

/** The mount path of a `use()` layer as path segments (params as ":name"), or null when its expression is not one a plain path makes. */
function mountSegments(layer: Layer): string[] | null {
  const regexp = layer.regexp;
  if (!regexp) return null;
  if (regexp.fast_slash) return [];
  let source = regexp.source;
  if (!source.startsWith("^") || !source.endsWith(MOUNT_TAIL)) return null;
  source = source.slice(1, source.length - MOUNT_TAIL.length);
  let next = 0;
  const keys = layer.keys ?? [];
  source = source.replace(PARAM_GROUP, () => `\\/:${String(keys[next++]?.name)}`);
  // Whatever is still special after the escapes are taken out is a pattern, not a path.
  if (/[()[\]{}*+?|^$]/.test(source.replace(/\\./g, ""))) return null;
  return source.replace(/\\(.)/g, "$1").split("/").filter(Boolean);
}

/** The segments of a route path string, or null when it holds a pattern (wildcard, optional or custom parameter). */
function routeSegments(path: string): string[] | null {
  if (/[*?()+]/.test(path)) return null;
  return path.split("/").filter(Boolean);
}

/** Whether a guard mounted at `guard` runs for a request to `route`: its segments are a leading part of the route's, a parameter matching any segment. */
function guardCovers(guard: string[], route: string[]): boolean {
  return guard.length <= route.length && guard.every((segment, i) => segment === route[i] || segment.startsWith(":") || route[i].startsWith(":"));
}

/** The key two registrations of one route share: the parameter names do not matter to the router. */
function routeKey(method: string, segments: string[]): string {
  return `${method.toUpperCase()} /${segments.map((s) => (s.startsWith(":") ? ":" : s)).join("/")}`;
}

/** `skipMounts`: mount paths ("/sonarr") whose routes are not listed. */
export function walkRoutes(app: Express, skipMounts: string[] = []): RouteWalk {
  const walk: RouteWalk = { routes: [], shadowed: [], skippedMounts: [], unclassified: [] };
  const seen = new Set<string>();
  /** Every requireAdmin that sits in a router.use(), in the order a request meets them. */
  const guards: string[][] = [];

  const visit = (stack: Layer[], prefix: string[]): void => {
    for (const layer of stack) {
      if (layer.route) {
        addRoute(layer, prefix);
        continue;
      }
      const isRouter = layer.name === "router" && Array.isArray(layer.handle?.stack);
      const isApp = layer.name === "mounted_app";
      const isGuard = layer.handle === (requireAdmin as unknown);
      if (!isRouter && !isApp && !isGuard) continue;
      const mount = mountSegments(layer);
      if (!mount) {
        walk.unclassified.push(`a ${isGuard ? "guard" : isApp ? "sub-application" : "router"} mounted at a path pattern: ${layer.regexp?.source}`);
        continue;
      }
      const at = [...prefix, ...mount];
      const mountPath = `/${at.join("/")}`;
      if (isApp || (isRouter && skipMounts.includes(mountPath))) walk.skippedMounts.push(mountPath);
      else if (isRouter) visit(layer.handle!.stack!, at);
      else guards.push(at);
    }
  };

  const addRoute = (layer: Layer, prefix: string[]): void => {
    const route = layer.route!;
    const paths = Array.isArray(route.path) ? route.path : [route.path];
    const methods = route.methods._all ? METHODS : METHODS.filter((m) => route.methods[m]);
    for (const path of paths) {
      const own = typeof path === "string" ? routeSegments(path) : null;
      if (!own) {
        walk.unclassified.push(`a route path that is not a plain path: ${String(path)} (under /${prefix.join("/")})`);
        continue;
      }
      const segments = [...prefix, ...own];
      for (const method of methods) {
        const key = routeKey(method, segments);
        if (seen.has(key)) {
          walk.shadowed.push(key);
          continue;
        }
        seen.add(key);
        const chain = route.stack.filter((l) => !l.method || l.method === method);
        const admin = chain.some((l) => l.handle === (requireAdmin as unknown)) || guards.some((g) => guardCovers(g, segments));
        walk.routes.push({ method, path: `/${segments.join("/")}`, admin });
      }
    }
  };

  const router = (app as unknown as { _router?: { stack: Layer[] } })._router;
  if (router) visit(router.stack, []);
  return walk;
}
