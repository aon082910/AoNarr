import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Request, Response } from "express";
import { config } from "../config.js";
import { getSetting } from "../services/settingsStore.js";
import { log } from "../services/logger.js";

/**
 * Every tool below is a thin proxy onto AoNarr's own REST API (loopback, authenticated with the
 * same instance API key any other automation already uses) rather than a reimplementation of its
 * logic — one source of truth for validation/business rules, and an MCP client gets exactly what
 * the web UI itself would do. Mounted at /api/mcp, so it inherits the same requireAuth gate (and
 * the "full control" trust level that implies) as every other /api route — no separate token.
 */
async function callApi(method: string, path: string, body?: unknown): Promise<unknown> {
  const apiKey = getSetting("apiKey");
  const res = await fetch(`http://127.0.0.1:${config.port}${path}`, {
    method,
    headers: { "X-Api-Key": apiKey ?? "", "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message = typeof data === "object" && data && "error" in (data as any) ? (data as any).error : text;
    throw new Error(`AoNarr API ${method} ${path} failed (HTTP ${res.status}): ${message}`);
  }
  return data;
}

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown) {
  return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true };
}

export function createAoNarrMcpServer(): McpServer {
  const server = new McpServer({ name: "aonarr", version: "1.0.0" });

  server.registerTool(
    "list_media_types",
    {
      title: "List media types",
      description: "Lists every library type AoNarr manages (movie, series, author, audiobook, comic, manga, podcast, etc.) with their labels and shape.",
      inputSchema: {},
    },
    async () => {
      try {
        return textResult(await callApi("GET", "/api/media-types"));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "search_library",
    {
      title: "Search the library",
      description: "Full-text search across every library already in AoNarr (titles, episodes, albums, issues, etc.) — for finding what's already added, not for discovering new media to add.",
      inputSchema: { query: z.string().describe("Search text") },
    },
    async ({ query }) => {
      try {
        return textResult(await callApi("GET", `/api/library-search?q=${encodeURIComponent(query)}`));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "list_media",
    {
      title: "List media items",
      description: "Lists media items in one library type, optionally filtered by status (e.g. 'missing').",
      inputSchema: {
        type: z.string().describe("Library type key, e.g. movie, series, author, audiobook, comic, manga, podcast, artist, rom"),
        status: z.string().optional().describe("Optional status filter, e.g. 'missing'"),
      },
    },
    async ({ type, status }) => {
      try {
        const qs = new URLSearchParams({ type, ...(status ? { status } : {}) });
        return textResult(await callApi("GET", `/api/media?${qs.toString()}`));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_media",
    {
      title: "Get one media item",
      description: "Full detail for one media item by id, including its children (episodes/albums/issues) if any.",
      inputSchema: { id: z.number().describe("Media item id") },
    },
    async ({ id }) => {
      try {
        return textResult(await callApi("GET", `/api/media/${id}`));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "search_metadata",
    {
      title: "Search metadata providers",
      description: "Searches a metadata provider (TMDB, Open Library, ComicVine, iTunes, etc.) for something to add — returns candidates with the externalIds add_media needs, not something already in the library.",
      inputSchema: {
        type: z.string().describe("Library type key to search within, e.g. movie, series, author, podcast"),
        query: z.string().describe("Title/name to search for"),
        provider: z.string().optional().describe("Specific provider key; omits to use the type's default"),
      },
    },
    async ({ type, query, provider }) => {
      try {
        const qs = new URLSearchParams({ type, query, ...(provider ? { provider } : {}) });
        return textResult(await callApi("GET", `/api/metadata/search?${qs.toString()}`));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "add_media",
    {
      title: "Add a media item",
      description: "Adds a new media item to the library from a search_metadata result — pass its externalIds through unchanged so provider-specific children (episodes/albums/chapters/feed episodes) populate automatically.",
      inputSchema: {
        type: z.string().describe("Library type key, e.g. movie, series, author, podcast"),
        title: z.string(),
        year: z.number().optional(),
        overview: z.string().optional(),
        posterUrl: z.string().optional(),
        externalIds: z.record(z.string(), z.string()).optional().describe("From a search_metadata result — required for the item to auto-populate its children"),
        rootFolderId: z.number().optional().describe("Omit to auto-select the first root folder configured for this type"),
        qualityProfileId: z.number().optional(),
        monitored: z.boolean().optional().default(true),
      },
    },
    async (args) => {
      try {
        return textResult(await callApi("POST", "/api/media", args));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "delete_media",
    {
      title: "Delete a media item",
      description: "Removes a media item from AoNarr. By default only untracks it (files stay on disk); pass deleteFiles: true to also recycle its file(s).",
      inputSchema: {
        id: z.number(),
        deleteFiles: z.boolean().optional().default(false),
      },
    },
    async ({ id, deleteFiles }) => {
      try {
        await callApi("DELETE", `/api/media/${id}${deleteFiles ? "?deleteFiles=1" : ""}`);
        return textResult({ deleted: true, id });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "set_monitored",
    {
      title: "Set monitored status",
      description: "Toggles whether AoNarr keeps searching for/downloading a media item.",
      inputSchema: { id: z.number(), monitored: z.boolean() },
    },
    async ({ id, monitored }) => {
      try {
        return textResult(await callApi("PATCH", `/api/media/${id}`, { monitored: monitored ? 1 : 0 }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "search_releases",
    {
      title: "Search indexers for a release",
      description: "Searches configured indexers for downloadable releases of a media item (or one of its episodes/sub-items), annotated with quality/format match info — the list to pick a downloadUrl from for grab_release.",
      inputSchema: {
        mediaItemId: z.number(),
        episodeId: z.number().optional(),
        subItemId: z.number().optional(),
      },
    },
    async ({ mediaItemId, episodeId, subItemId }) => {
      try {
        const qs = new URLSearchParams();
        if (episodeId) qs.set("episodeId", String(episodeId));
        if (subItemId) qs.set("subItemId", String(subItemId));
        const suffix = qs.toString() ? `?${qs.toString()}` : "";
        return textResult(await callApi("GET", `/api/search/${mediaItemId}${suffix}`));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "grab_release",
    {
      title: "Grab a release",
      description: "Sends a specific release (from search_releases) to a download client and adds it to the queue.",
      inputSchema: {
        mediaItemId: z.number(),
        downloadUrl: z.string(),
        downloadClientId: z.number(),
        title: z.string().optional(),
        episodeId: z.number().optional(),
        subItemId: z.number().optional(),
        size: z.number().optional(),
      },
    },
    async ({ mediaItemId, ...rest }) => {
      try {
        return textResult(await callApi("POST", `/api/search/${mediaItemId}/grab`, rest));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_queue",
    {
      title: "Get the download queue",
      description: "Lists everything currently queued/downloading/importing.",
      inputSchema: {},
    },
    async () => {
      try {
        return textResult(await callApi("GET", "/api/activity/queue"));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_system_health",
    {
      title: "Get system health",
      description: "Indexer reachability, download-client status, and stuck-queue detection — AoNarr's own one-stop health view.",
      inputSchema: {},
    },
    async () => {
      try {
        return textResult(await callApi("GET", "/api/system/health"));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_setting",
    {
      title: "Get a setting value",
      description: "Reads one AoNarr setting by key (see the web UI's Settings page for key names).",
      inputSchema: { key: z.string() },
    },
    async ({ key }) => {
      try {
        // No per-key GET route exists — settings.ts only exposes GET / (every key at once) and
        // PUT /:key, matching how the Settings page itself loads (fetches everything once, reads
        // the one field it needs).
        const all = (await callApi("GET", "/api/settings")) as Record<string, string>;
        return textResult({ key, value: key in all ? all[key] : null });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "set_setting",
    {
      title: "Set a setting value",
      description: "Writes one AoNarr setting by key — the same mechanism the Settings page uses. Be precise: this changes live instance configuration.",
      inputSchema: { key: z.string(), value: z.string() },
    },
    async ({ key, value }) => {
      try {
        return textResult(await callApi("PUT", `/api/settings/${encodeURIComponent(key)}`, { value }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  return server;
}

/**
 * Stateless MCP handler — a fresh McpServer + transport per request, no session tracking. Simple
 * and correct for a server whose own tools are already stateless REST proxies; the SDK's own
 * session-management mode exists for servers that need server-side state between calls, which
 * none of these tools do.
 */
export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const server = createAoNarrMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    // AoNarr's own Express Request augments `.auth` with its own AuthContext shape (see
    // middleware/auth.ts) — structurally incompatible with the SDK's unrelated AuthInfo type for
    // its own OAuth flow, which this integration doesn't use. Safe to widen here.
    await transport.handleRequest(req as any, res, req.body);
  } catch (err) {
    log.warn("[mcp] request failed:", (err as Error).message);
    if (!res.headersSent) {
      res.status(500).json({ error: "MCP request failed" });
    }
  }
}
