import fs from "node:fs";
import path from "node:path";
import { parseNfo } from "./nfoParser.js";
import { parseComicInfoXml, findComicInfoInCbz } from "./comicInfoParser.js";
import { parseOpf } from "./opfParser.js";
import { resolveLocalArtwork } from "./localArtwork.js";
import type { MediaTypeConfig } from "./mediaTypes.js";

export interface SidecarMetadata {
  title: string | null;
  /** Only meaningful for ComicInfo.xml — its <Series> tag, the collection-parent's own title,
   * distinct from `title` (this one issue's own title), since a single ComicInfo.xml carries both
   * at once (unlike Kodi's split show/episode NFO files). */
  parentTitle?: string | null;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  externalIds: Record<string, string>;
  contentRating?: string | null;
  genres?: string[];
  /** Only meaningful for an episode-level Kodi episodedetails.nfo. */
  season?: number | null;
  episode?: number | null;
  /** An absolute on-disk path for a *local* poster/backdrop image, when this sidecar's own folder
   * has one (see localArtwork.ts) — Kodi's poster.jpg/fanart.jpg convention, or a <thumb> value
   * that names a local file rather than a real URL. `posterUrl` above stays reserved for an actual
   * fetchable remote URL; these are mutually exclusive per item (never both set for the same
   * artwork kind) since a browser can't load either "from" the other. */
  localPosterPath?: string | null;
  localBackdropPath?: string | null;
}

// "Specials" is Kodi/Plex/Jellyfin's Season 0 folder, so its show's tvshow.nfo is one level up too.
const SEASON_FOLDER = /^season\s*0*(\d{1,3})$|^s0*(\d{1,3})$|^specials$/i;

/** Same "parent is just a Season NN folder → use its own parent instead" logic
 * libraryScan.ts's guessShowTitleFromFolder already has — duplicated here (rather than imported)
 * to avoid a circular import between the two modules; libraryScan.ts is the one that imports
 * *this* file, not the other way around. */
function resolveShowFolder(parentDir: string): string {
  const parentName = path.basename(parentDir);
  return SEASON_FOLDER.test(parentName) ? path.dirname(parentDir) : parentDir;
}

function readIfExists(filePath: string): string | null {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;
  } catch {
    return null;
  }
}

async function tryParseNfoFile(filePath: string): Promise<SidecarMetadata | null> {
  const xml = readIfExists(filePath);
  if (!xml) return null;
  try {
    const parsed: SidecarMetadata = await parseNfo(xml);
    if (!parsed.title) return null;
    // Every Kodi-convention NFO this function ever reads (movie.nfo, tvshow.nfo, artist.nfo,
    // album.nfo) sits in the exact same folder as its own poster.jpg/fanart.jpg, so resolving
    // local artwork here — once — covers all of them instead of repeating this in every wrapper
    // below.
    const { posterPath, backdropPath } = resolveLocalArtwork(path.dirname(filePath), parsed.posterUrl);
    if (posterPath) {
      parsed.posterUrl = null;
      parsed.localPosterPath = posterPath;
    }
    if (backdropPath) parsed.localBackdropPath = backdropPath;
    return parsed;
  } catch {
    // Malformed/non-XML file sitting at a Kodi-conventional path — treat as "no sidecar", never
    // fail the scan/refresh over a bad file.
    return null;
  }
}

/** Show-level sidecar for an episodic type (tvshow.nfo) — checked against the file's own parent
 * folder first, then (season-folder-aware) its show folder, so both a flat "Show/ep.mkv" layout
 * and a "Show/Season 01/ep.mkv" layout find the same tvshow.nfo. Only meaningful for
 * `sidecarFormat: "kodi-video"` types; callers gate on that themselves. */
export async function findShowSidecar(parentDir: string): Promise<SidecarMetadata | null> {
  const showFolder = resolveShowFolder(parentDir);
  return (await tryParseNfoFile(path.join(parentDir, "tvshow.nfo"))) ?? (await tryParseNfoFile(path.join(showFolder, "tvshow.nfo")));
}

/** Episode-level sidecar (Kodi's own-basename-.nfo convention, e.g. "S01E01.nfo" next to
 * "S01E01.mkv") — season/episode/title for one specific episode file. */
export async function findEpisodeSidecar(filePath: string): Promise<SidecarMetadata | null> {
  const base = path.basename(filePath, path.extname(filePath));
  const dir = path.dirname(filePath);
  return tryParseNfoFile(path.join(dir, `${base}.nfo`));
}

/** Single-shape item sidecar (Movies, Sports PPV) — the file's own basename.nfo (Kodi's actual
 * real-world convention for a movie sitting in its own folder), falling back to a bare movie.nfo
 * in the same folder. */
export async function findMovieSidecar(filePath: string): Promise<SidecarMetadata | null> {
  const base = path.basename(filePath, path.extname(filePath));
  const dir = path.dirname(filePath);
  return (await tryParseNfoFile(path.join(dir, `${base}.nfo`))) ?? (await tryParseNfoFile(path.join(dir, "movie.nfo")));
}

/** artist.nfo in the artist's own folder — the collection-parent-level sidecar for Music. */
export async function findArtistSidecar(artistDir: string): Promise<SidecarMetadata | null> {
  return tryParseNfoFile(path.join(artistDir, "artist.nfo"));
}

/** album.nfo in the album's own folder — the child-level sidecar for Music. */
export async function findAlbumSidecar(albumDir: string): Promise<SidecarMetadata | null> {
  return tryParseNfoFile(path.join(albumDir, "album.nfo"));
}

/** Both music sidecars at once, for a call site that already has both folder paths in hand.
 * Either may be absent independently (an admin might only have one written) — both are checked
 * and returned together rather than short-circuiting on the first found. */
export async function findMusicSidecars(
  artistDir: string,
  albumDir: string
): Promise<{ artist: SidecarMetadata | null; album: SidecarMetadata | null }> {
  const [artist, album] = await Promise.all([findArtistSidecar(artistDir), findAlbumSidecar(albumDir)]);
  return { artist, album };
}

/** Where a per-item sidecar is being looked up for, so a folder-wide sidecar file (metadata.opf,
 * a bare ComicInfo.xml) is only trusted when it can only be describing this one file. */
export interface FolderSidecarScope {
  /** The item's own folder IS the item (an Audiobooks book folder), so its folder-wide sidecar
   * always describes it. */
  folderIsChild?: boolean;
  /** The type's file extensions — without folderIsChild, a folder-wide sidecar only applies when
   * the folder holds no other item of this type. Defaults to the file's own extension. */
  extensions?: readonly string[];
  /** The library root the file sits in. A folder-wide sidecar in the root itself never applies to
   * a file loose in that root — it names no particular file. */
  rootPath?: string | null;
}

/** Filesystem clutter a Mac or NAS leaves beside real files, never media: macOS AppleDouble
 * companions ("._Dune.epub", a few-KB resource fork written next to every file a Mac copies onto an
 * SMB share or exFAT drive), .DS_Store, and the metadata folders of macOS and Netatalk. */
export function isOsMetadataEntry(name: string): boolean {
  return name.startsWith("._") || /^\.(?:DS_Store|AppleDouble|AppleDB|AppleDesktop|Trashes|Spotlight-V100|fseventsd|TemporaryItems)$/i.test(name);
}

/** Whether `filePath` is the only item of its type in its folder — the same book saved in several
 * formats ("Title.epub" + "Title.mobi") still counts as one. */
export function holdsOnlyThisItem(filePath: string, extensions?: readonly string[]): boolean {
  const exts = (extensions ?? [path.extname(filePath)]).map((e) => e.toLowerCase());
  const own = path.basename(filePath, path.extname(filePath)).toLowerCase();
  try {
    for (const entry of fs.readdirSync(path.dirname(filePath), { withFileTypes: true })) {
      if (!entry.isFile() || isOsMetadataEntry(entry.name) || !exts.includes(path.extname(entry.name).toLowerCase())) continue;
      if (path.basename(entry.name, path.extname(entry.name)).toLowerCase() !== own) return false;
    }
  } catch {
    return false;
  }
  return true;
}

/** The folder-wide sidecar's text, when it exists and may describe `filePath` (see FolderSidecarScope). */
function readFolderSidecar(filePath: string, name: string, scope: FolderSidecarScope): string | null {
  const sidecarPath = path.join(path.dirname(filePath), name);
  if (!fs.existsSync(sidecarPath)) return null;
  if (scope.rootPath && path.resolve(path.dirname(filePath)) === path.resolve(scope.rootPath)) return null;
  if (!scope.folderIsChild && !holdsOnlyThisItem(filePath, scope.extensions)) return null;
  return readIfExists(sidecarPath);
}

/** ComicInfo.xml for one comic/manga issue — checked inside the archive first (the real-world
 * convention for a .cbz, via findComicInfoInCbz), then an external "<basename>.xml" next to the
 * file, then a bare "ComicInfo.xml" in its folder for anything else (.cbr, .pdf, or a .cbz that
 * just doesn't have one embedded) — the bare one only when it can't be another issue's (see
 * FolderSidecarScope); otherwise every issue in a series folder took the same title and all but
 * the first were skipped as duplicates. */
export async function findComicSidecar(filePath: string, scope: FolderSidecarScope = {}): Promise<SidecarMetadata | null> {
  const embedded = findComicInfoInCbz(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const dir = path.dirname(filePath);
  const xml = embedded ?? readIfExists(path.join(dir, `${base}.xml`)) ?? readFolderSidecar(filePath, "ComicInfo.xml", scope);
  if (!xml) return null;
  try {
    const parsed = await parseComicInfoXml(xml);
    if (!parsed.series && !parsed.title) return null;
    return {
      title: parsed.title,
      parentTitle: parsed.series,
      year: parsed.year,
      overview: parsed.overview,
      posterUrl: null,
      externalIds: {},
      genres: parsed.genres,
    };
  } catch {
    return null;
  }
}

/** An OPF describing one book/audiobook: its own "<basename>.opf" first, then Calibre's
 * metadata.opf in the same folder — the latter only when the folder can't hold another book it
 * might be describing instead (see FolderSidecarScope); a stray metadata.opf in an author folder
 * of several books otherwise gave every one of them the same title. */
export async function findOpfSidecar(filePath: string, scope: FolderSidecarScope = {}): Promise<SidecarMetadata | null> {
  const ownPath = path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}.opf`);
  return (await parseOpfSidecar(readIfExists(ownPath))) ?? (await parseOpfSidecar(readFolderSidecar(filePath, "metadata.opf", scope)));
}

async function parseOpfSidecar(xml: string | null): Promise<SidecarMetadata | null> {
  if (!xml) return null;
  try {
    const parsed = await parseOpf(xml);
    if (!parsed.title) return null;
    return {
      title: parsed.title,
      parentTitle: parsed.author,
      year: parsed.year,
      overview: parsed.overview,
      posterUrl: null,
      externalIds: parsed.externalIds,
    };
  } catch {
    return null;
  }
}

/** Single dispatch point matching a type's configured `sidecarFormat` (see mediaTypes.ts) to the
 * right lookup above for a single-shape item's own file, an episode file, or a collection child's
 * file — everything except the music (two-folder) and show-level (tvshow.nfo) cases, which need
 * more than one path and are called directly by their own exports above. Returns null outright for
 * a type with no `sidecarFormat` configured, so every call site can call this unconditionally. */
export async function findFileSidecar(
  typeConfig: MediaTypeConfig,
  filePath: string,
  rootPath?: string | null
): Promise<SidecarMetadata | null> {
  const scope: FolderSidecarScope = { folderIsChild: !!typeConfig.multiFilePerChild, extensions: typeConfig.extensions, rootPath };
  switch (typeConfig.sidecarFormat) {
    case "kodi-video":
      return typeConfig.shape === "episodic" ? findEpisodeSidecar(filePath) : findMovieSidecar(filePath);
    case "comicinfo":
      return findComicSidecar(filePath, scope);
    case "opf":
      return findOpfSidecar(filePath, scope);
    default:
      return null;
  }
}
