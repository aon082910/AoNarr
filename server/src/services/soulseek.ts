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

/** A shared folder as one download: the user, the folder's path and the files in it (name and size). */
export interface SlskdFolder {
  username: string;
  directory: string;
  files: { filename: string; size: number }[];
}

export function encodeSlskdFolderUrl(folder: SlskdFolder): string {
  const files = Buffer.from(JSON.stringify(folder.files.map((f) => [f.filename, f.size]))).toString("base64url");
  return `slskd://${encodeURIComponent(folder.username)}/${encodeURIComponent(folder.directory)}?folder=1&files=${files}`;
}

/** The folder a `slskd://` URL names, or null for a URL that names a single file. */
export function decodeSlskdFolderUrl(downloadUrl: string): SlskdFolder | null {
  let url: URL;
  try {
    url = new URL(downloadUrl);
  } catch {
    return null;
  }
  if (url.searchParams.get("folder") !== "1") return null;
  const username = decodeURIComponent(url.hostname);
  const directory = decodeURIComponent(url.pathname.replace(/^\//, ""));
  let files: { filename: string; size: number }[] = [];
  try {
    const parsed = JSON.parse(Buffer.from(url.searchParams.get("files") ?? "", "base64url").toString("utf8")) as [string, number][];
    files = parsed.filter((f) => Array.isArray(f) && typeof f[0] === "string").map(([filename, size]) => ({ filename, size: Number(size) || 0 }));
  } catch {
    return null;
  }
  if (!username || !directory || files.length === 0) return null;
  return { username, directory, files };
}

/** Separates the parts of a folder download's id, which no file name holds. */
const FOLDER_ID_SEPARATOR = "\u001f";

/** The id a folder download is tracked by: user, folder and how many files were asked for. */
export function slskdFolderDownloadId(folder: SlskdFolder): string {
  return ["slskd-folder", folder.username, folder.directory, String(folder.files.length)].join(FOLDER_ID_SEPARATOR);
}

export function parseSlskdFolderDownloadId(downloadId: string): { username: string; directory: string; count: number } | null {
  const parts = downloadId.split(FOLDER_ID_SEPARATOR);
  if (parts.length !== 4 || parts[0] !== "slskd-folder") return null;
  return { username: parts[1], directory: parts[2], count: Number(parts[3]) || 0 };
}

const AUDIO_FILE = /\.(?:flac|mp3|m4a|ogg|opus|wav|aac|wma|ape|wv|aiff?|alac|dsf)$/i;
const directoryOf = (filename: string): string => {
  const at = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\"));
  return at < 0 ? "" : filename.slice(0, at);
};

/** "Artist - Album" out of the last two folders of a shared path, the way a release is named. */
function folderTitle(directory: string): string {
  const parts = directory.split(/[/\\]/).filter(Boolean);
  return parts.slice(-2).join(" - ");
}

/** The format of a folder of tracks as a release name tag: "[FLAC]", "[MP3 320]", "[MP3]" for mixed bitrates. */
function folderFormatTag(files: SlskdSearchFile[]): string {
  const extensions = new Set(files.map((f) => (f.filename.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toUpperCase()));
  if (extensions.size !== 1) return "";
  const [extension] = Array.from(extensions);
  if (extension !== "MP3") return ` [${extension}]`;
  const rates = new Set(files.map((f) => f.bitRate).filter((r): r is number => typeof r === "number" && r > 0));
  return rates.size === 1 ? ` [MP3 ${Array.from(rates)[0]}]` : " [MP3]";
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
    // Two or more tracks of one shared folder are one release, the album (Soulseek shares albums folder by folder):
    // its title is the folder, its size the folder's and grabbing it asks for every track.
    const byDirectory = new Map<string, SlskdSearchFile[]>();
    for (const f of r.files) {
      if (!AUDIO_FILE.test(f.filename)) continue;
      const directory = directoryOf(f.filename);
      if (!directory) continue;
      byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), f]);
    }
    const grouped = new Set<SlskdSearchFile>();
    for (const [directory, files] of byDirectory) {
      if (files.length < 2) continue;
      for (const f of files) grouped.add(f);
      results.push({
        indexerId: null,
        indexerName: `Soulseek (${r.username})`,
        title: `${folderTitle(directory)}${folderFormatTag(files)}`,
        size: files.reduce((sum, f) => sum + (f.size || 0), 0),
        seeders: null,
        leechers: null,
        publishDate: null,
        downloadUrl: encodeSlskdFolderUrl({ username: r.username, directory, files: files.map((f) => ({ filename: f.filename, size: f.size })) }),
        protocol: "slskd",
        category: null,
      });
    }
    for (const f of r.files) {
      if (grouped.has(f)) continue;
      results.push({
        indexerId: null,
        indexerName: `Soulseek (${r.username})`,
        title: f.filename.split(/[/\\]/).pop() ?? f.filename,
        size: f.size,
        // Soulseek has no seeder-count concept — `null` (not a fabricated 0/1 off hasFreeUploadSlot)
        // is what every other seederless protocol in this codebase uses, since real cross-protocol
        // sort/tiebreak logic treats seeders as a comparable peer count, not a upload-slot flag.
        seeders: null,
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
