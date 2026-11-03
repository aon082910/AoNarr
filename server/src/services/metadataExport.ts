import fs from "node:fs";
import path from "node:path";
import { getMediaTypeConfig } from "./mediaTypes.js";
import { log } from "./logger.js";
import { fetchMediaServerArtwork, isMediaServerArtworkRef } from "./mediaServer.js";
import { fetchScreenscraperArtwork, isScreenscraperArtworkRef } from "./metadata.js";

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface ExportableItem {
  type: string;
  title: string;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  externalIds: Record<string, string>;
}

/** Kodi/Jellyfin/Emby-style .nfo sidecar — the same shape services/nfoParser.ts already reads
 * back in, so an exported file round-trips through Import Media's "Load NFO" unchanged. Root tag
 * follows shape, not a hardcoded type list: episodic (series/anime) and collection (Music/Books/
 * Comics/Manga/Online Videos/Courses/...) types are all a parent-with-children folder on disk, the
 * same structural shape Kodi's tvshow.nfo describes — "movie" is only right for a single-file item
 * (Movies/ROMs/Adult). */
export function buildNfo(item: ExportableItem): string {
  const shape = getMediaTypeConfig(item.type).shape;
  const root = shape === "episodic" || shape === "collection" ? "tvshow" : "movie";
  const uniqueIds = Object.entries(item.externalIds ?? {})
    .map(([provider, id]) => `  <uniqueid type="${escapeXml(provider)}">${escapeXml(id)}</uniqueid>`)
    .join("\n");
  // poster_url can also be AoNarr's own local-artwork route (services/localArtwork.ts) rather
  // than a real fetchable URL, when the source was a local poster.jpg/fanart.jpg or a relative
  // <thumb> — meaningless written back into a real .nfo file (it's an internal path, not
  // something anything outside AoNarr could ever resolve), so it's skipped here rather than
  // round-tripped verbatim.
  const exportablePosterUrl = item.posterUrl && !item.posterUrl.startsWith("/api/media/local-artwork/") ? item.posterUrl : null;

  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<${root}>`,
    `  <title>${escapeXml(item.title)}</title>`,
    item.year ? `  <year>${item.year}</year>` : null,
    item.overview ? `  <plot>${escapeXml(item.overview)}</plot>` : null,
    exportablePosterUrl ? `  <thumb aspect="poster">${escapeXml(exportablePosterUrl)}</thumb>` : null,
    uniqueIds || null,
    `</${root}>`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildJson(item: ExportableItem): string {
  return JSON.stringify(item, null, 2);
}

/** Calibre-compatible OPF sidecar (the format its GUI/command-line import reads for per-book
 * metadata) — for the book-shaped libraries (Books, Audiobooks, Comics, Manga). Calibre treats
 * `dc:creator` as the author; AoNarr doesn't model an author-vs-title-of-work distinction for
 * these types (the media_item title covers both roles depending on how the library's organized),
 * so both fields are set to the same title as a reasonable default the user can edit in Calibre. */
export function buildCalibreOpf(item: ExportableItem): string {
  const isbn = item.externalIds?.isbn;
  const identifiers = [
    isbn ? `    <dc:identifier opf:scheme="ISBN">${escapeXml(isbn)}</dc:identifier>` : null,
    ...Object.entries(item.externalIds ?? {})
      .filter(([p]) => p !== "isbn")
      .map(([provider, id]) => `    <dc:identifier opf:scheme="${escapeXml(provider)}">${escapeXml(id)}</dc:identifier>`),
  ]
    .filter(Boolean)
    .join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<package xmlns="http://www.idpf.org/2007/opf" version="2.0">`,
    `  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">`,
    `    <dc:title>${escapeXml(item.title)}</dc:title>`,
    `    <dc:creator opf:role="aut">${escapeXml(item.title)}</dc:creator>`,
    item.year ? `    <dc:date>${item.year}-01-01T00:00:00+00:00</dc:date>` : null,
    item.overview ? `    <dc:description>${escapeXml(item.overview)}</dc:description>` : null,
    identifiers || null,
    `  </metadata>`,
    `</package>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Plex's own local-metadata override file — unlike Kodi/Jellyfin/Emby, Plex's built-in agents
 * don't read .nfo sidecars at all; the closest equivalent is `.plexmatch`, a plain key:value text
 * file (introduced in Plex Media Server 1.25) that forces a match to a specific TMDB/IMDb/TVDB id
 * instead of relying on filename parsing. Must be named exactly `.plexmatch` and live directly in
 * the item's own folder (a movie's folder, or a show's top-level folder) for Plex to pick it up —
 * never per-title-named like the other sidecar formats, so callers zip it into a per-item folder
 * the same way the Calibre export already does for metadata.opf/cover.jpg.
 */
export function buildPlexMatch(item: ExportableItem): string {
  const ids = item.externalIds ?? {};
  return [
    `title: ${item.title}`,
    item.year ? `year: ${item.year}` : null,
    ids.tmdb ? `tmdbid: ${ids.tmdb}` : null,
    ids.imdb ? `imdbid: ${ids.imdb}` : null,
    ids.tvdb ? `tvdbid: ${ids.tvdb}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function safeFileName(title: string): string {
  return title.replace(/[/\\:*?"<>|]/g, "").trim().slice(0, 200);
}

/**
 * Keeps a Kodi/Jellyfin/Emby-style .nfo sidecar next to a media file in sync with AoNarr's own
 * record — same basename as the file itself (e.g. "Movie (2020).mkv" -> "Movie (2020).nfo"), the
 * convention those tools already scan for. Called whenever an item's title/year/overview/poster
 * is edited (manual edit, merge-apply, rematch — see routes/media.ts) so a media server picks up
 * the correction on its next scan instead of only AoNarr knowing about it. Silently skipped (never
 * throws) on any filesystem error — a failed sidecar write is a nice-to-have, not something that
 * should fail the metadata edit that triggered it.
 */
export function writeNfoSidecar(filePath: string, item: ExportableItem, options: { keepRicher?: boolean } = {}): void {
  try {
    const dir = path.dirname(filePath);
    const nfoPath = path.join(dir, `${path.basename(filePath, path.extname(filePath))}.nfo`);
    // An import of a better copy must not replace the NFO another tool wrote (cast, genres, ratings): it only
    // refreshes a sidecar that AoNarr wrote, or none. A movie.nfo beside the file counts too, since Kodi reads it first.
    if (options.keepRicher && [nfoPath, path.join(dir, "movie.nfo")].some((candidate) => existingNfoIsRicher(candidate))) return;
    fs.writeFileSync(nfoPath, buildNfo(item));
  } catch (err) {
    log.warn(`[metadataExport] failed to write NFO sidecar for "${item.title}":`, (err as Error).message);
  }
}

// The only elements AoNarr writes. An existing sidecar made of nothing else is one AoNarr wrote (or one no richer
// than it), so rewriting it loses nothing.
const AONARR_NFO_ELEMENTS = new Set([
  "movie", "tvshow", "title", "year", "plot", "thumb", "uniqueid",
  "episodedetails", "showtitle", "season", "episode", "aired",
]);

export function isAonarrShapedNfo(content: string): boolean {
  const body = content
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  if (!body) return true;
  if (!/^<(movie|tvshow|episodedetails)[\s>]/.test(body) || !/<\/(movie|tvshow|episodedetails)>$/.test(body)) return false;
  return [...body.matchAll(/<\/?([A-Za-z_][\w.:-]*)/g)].every((m) => AONARR_NFO_ELEMENTS.has(m[1].toLowerCase()));
}

/** Whether a file is there and holds more than AoNarr writes: another tool's NFO. An unreadable one counts, to be safe. */
function existingNfoIsRicher(nfoPath: string): boolean {
  try {
    return !isAonarrShapedNfo(fs.readFileSync(nfoPath, "utf-8"));
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export interface ExportableEpisode {
  showTitle: string;
  title: string | null;
  season: number;
  episode: number;
  aired: string | null;
  overview: string | null;
}

/** Kodi's `<episodedetails>`, one block per episode the file covers. */
export function buildEpisodeNfo(episodes: ExportableEpisode[]): string {
  const blocks = episodes.map((e) =>
    [
      `<episodedetails>`,
      `  <title>${escapeXml(e.title ?? `Episode ${e.episode}`)}</title>`,
      `  <showtitle>${escapeXml(e.showTitle)}</showtitle>`,
      `  <season>${e.season}</season>`,
      `  <episode>${e.episode}</episode>`,
      e.aired ? `  <aired>${escapeXml(e.aired)}</aired>` : null,
      e.overview ? `  <plot>${escapeXml(e.overview)}</plot>` : null,
      `</episodedetails>`,
    ]
      .filter(Boolean)
      .join("\n")
  );
  return [`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`, ...blocks].join("\n");
}

/** `<basename>.nfo` for an episode file, unless another tool's NFO is already there. Never throws. */
export function writeEpisodeNfoSidecar(filePath: string, episodes: ExportableEpisode[]): void {
  try {
    const nfoPath = path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}.nfo`);
    if (existingNfoIsRicher(nfoPath)) return;
    fs.writeFileSync(nfoPath, buildEpisodeNfo(episodes));
  } catch (err) {
    log.warn(`[metadataExport] failed to write the episode NFO for "${filePath}":`, (err as Error).message);
  }
}

/** `tvshow.nfo` in the show's folder, only when none is there (the show's own is written once, not on every import). Never throws. */
export function writeTvShowNfoIfMissing(folder: string, item: ExportableItem): void {
  try {
    const nfoPath = path.join(folder, "tvshow.nfo");
    if (fs.existsSync(nfoPath)) return;
    fs.writeFileSync(nfoPath, buildNfo(item));
  } catch (err) {
    log.warn(`[metadataExport] failed to write tvshow.nfo for "${item.title}":`, (err as Error).message);
  }
}

/**
 * Downloads the actual poster image bytes for a bulk export — the .nfo/.opf sidecar alone only
 * embeds `posterUrl` as a remote reference, which needs AoNarr (or internet access) to resolve
 * later. Plex/Kodi/Jellyfin/Emby's local media agents all recognize a real `poster.jpg` (or
 * `cover.jpg`, Calibre's own convention) sitting next to the sidecar, so a bulk export is more
 * useful as a genuinely self-contained package. Returns null (never throws) on any failure — a
 * missing/unreachable poster shouldn't fail the whole export, just that one item's image — and as
 * soon as `signal` aborts.
 */
export async function fetchPosterBuffer(posterUrl: string | null, localPath?: string | null, signal?: AbortSignal): Promise<Buffer | null> {
  if (signal?.aborted) return null;
  // A local poster (services/localArtwork.ts) already sits on disk — read it directly rather than
  // looping an HTTP request back through this same server for its own /api/media/local-artwork
  // route, which `posterUrl` would otherwise point at. `fetch()` also can't resolve that route's
  // path-only URL at all outside a browser (no scheme/host to resolve it against), so this isn't
  // just an optimization — without it, every local-poster item's export silently got no poster.jpg.
  // Proxied artwork (a media server's, ScreenScraper's) is fetched the way the local-artwork route
  // serves it, since the stored reference isn't a file path.
  const proxied = isMediaServerArtworkRef(localPath)
    ? fetchMediaServerArtwork(localPath)
    : isScreenscraperArtworkRef(localPath)
      ? fetchScreenscraperArtwork(localPath)
      : null;
  if (proxied) {
    return untilAborted(
      proxied.then(async (res) => (res ? Buffer.from(await res.arrayBuffer()) : null)),
      signal
    ).catch(() => null);
  }
  if (localPath) {
    try {
      return fs.readFileSync(localPath);
    } catch {
      return null;
    }
  }
  if (!posterUrl) return null;
  try {
    const res = await fetch(posterUrl, { signal });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** `promise`, or null once `signal` aborts — for helpers that take no signal of their own. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | null> {
  if (!signal) return promise;
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
