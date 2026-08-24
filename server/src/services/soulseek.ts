import type { DownloadClient } from "../types/index.js";
import type { SearchResult } from "../types/index.js";
import { log } from "./logger.js";

/**
 * Soulseek (via a slskd daemon — https://github.com/slskd/slskd) is architecturally unlike every
 * other download client AoNarr talks to: it's not a queue you hand a magnet/NZB/HTTP URL to.
 * Files only exist as (username, remote filename) pairs surfaced by slskd's own search, and a
 * download is enqueued against that specific user. There's no Torznab/Newznab indexer for
 * Soulseek, so results come from calling slskd directly rather than from indexerClient.ts.
 *
 * To slot into AoNarr's existing "search returns SearchResult[], grab posts {downloadUrl,
 * downloadClientId} back" flow without changing that contract, a result's `downloadUrl` here is a
 * `slskd://` pseudo-URI encoding exactly what the adapter's addDownload (in downloadClient.ts)
 * needs to re-issue the request: the owning username and the exact remote filename slskd gave us.
 */
function baseUrl(client: DownloadClient): string {
  const scheme = client.useSsl ? "https" : "http";
  return `${scheme}://${client.host}:${client.port}`;
}

function headers(client: DownloadClient): Record<string, string> {
  return client.apiKey ? { "X-API-Key": client.apiKey } : {};
}

export function encodeSlskdDownloadUrl(username: string, filename: string, size: number): string {
  return `slskd://${encodeURIComponent(username)}/${encodeURIComponent(filename)}?size=${size}`;
}

export function decodeSlskdDownloadUrl(downloadUrl: string): { username: string; filename: string; size: number } {
  const url = new URL(downloadUrl);
  const username = decodeURIComponent(url.hostname);
  const filename = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const size = Number(url.searchParams.get("size") ?? 0);
  if (!username || !filename) throw new Error(`Malformed slskd download URL: "${downloadUrl}"`);
  return { username, filename, size };
}

interface SlskdSearchFile {
  filename: string;
  size: number;
  bitRate?: number;
  length?: number;
}

interface SlskdSearchResponseEntry {
  username: string;
  files: SlskdSearchFile[];
  hasFreeUploadSlot?: boolean;
  uploadSpeed?: number;
}

/** slskd's search is async on their end too — a POST kicks it off, then it's polled until slskd
 * reports it complete (or a generous timeout is hit, since a real Soulseek search realistically
 * takes several seconds to gather responses from other peers). */
export async function searchSlskd(client: DownloadClient, query: string): Promise<SearchResult[]> {
  const createRes = await fetch(`${baseUrl(client)}/api/v0/searches`, {
    method: "POST",
    headers: { ...headers(client), "Content-Type": "application/json" },
    body: JSON.stringify({ searchText: query }),
  });
  if (!createRes.ok) throw new Error(`slskd search request failed: HTTP ${createRes.status}`);
  const created: any = await createRes.json();
  const searchId = created?.id;
  if (!searchId) throw new Error("slskd did not return a search id");

  const deadline = Date.now() + 15000;
  let isComplete = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const stateRes = await fetch(`${baseUrl(client)}/api/v0/searches/${searchId}`, { headers: headers(client) });
    if (!stateRes.ok) continue;
    const state: any = await stateRes.json();
    if (state?.isComplete) {
      isComplete = true;
      break;
    }
  }
  if (!isComplete) log.warn(`[slskd] search "${query}" didn't report complete before the timeout — returning results gathered so far`);

  const responsesRes = await fetch(`${baseUrl(client)}/api/v0/searches/${searchId}/responses`, { headers: headers(client) });
  if (!responsesRes.ok) throw new Error(`slskd search responses request failed: HTTP ${responsesRes.status}`);
  const responses = (await responsesRes.json()) as SlskdSearchResponseEntry[];

  const results: SearchResult[] = [];
  for (const r of responses) {
    for (const f of r.files) {
      results.push({
        indexerId: null,
        indexerName: `Soulseek (${r.username})`,
        title: f.filename.split(/[/\\]/).pop() ?? f.filename,
        size: f.size,
        seeders: r.hasFreeUploadSlot ? 1 : 0,
        leechers: null,
        publishDate: null,
        downloadUrl: encodeSlskdDownloadUrl(r.username, f.filename, f.size),
        protocol: "slskd",
        category: null,
      });
    }
  }
  return results;
}
