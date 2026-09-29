import { vi } from "vitest";
import type { MediaTypeInfo } from "../types.js";

type Handler = unknown | ((init: RequestInit | undefined) => unknown);

/** Replaces global fetch with a lookup keyed on the request path (query string ignored), so a page
 * renders against canned API responses instead of a live server. Any path without a handler
 * answers 404, which surfaces as a thrown ApiError in the page — the same as a real missing route.
 * A handler that returns a Response is passed through as-is (for non-2xx cases). */
export function mockApi(routes: Record<string, Handler>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.split("?")[0];
    if (!(path in routes)) {
      return new Response(JSON.stringify({ error: `No mock for ${path}` }), { status: 404 });
    }
    const handler = routes[path];
    const body = typeof handler === "function" ? (handler as (i?: RequestInit) => unknown)(init) : handler;
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export const MEDIA_TYPES: MediaTypeInfo[] = [
  { key: "movie", label: "Movies", shape: "single", childLabel: null, hasMetadataSearch: true, multiFilePerChild: false, groupLevels: [] },
  { key: "series", label: "TV Shows", shape: "episodic", childLabel: "Episode", hasMetadataSearch: true, multiFilePerChild: false, groupLevels: [] },
];
