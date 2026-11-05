import path from "node:path";
import { withTagSlot } from "./audioTagCommon.js";
import { albumYear } from "./discography.js";
import { albumWords, sameWords, type AlbumFolder, type DiscFolder, type FolderMatch, type MatchableAlbum } from "./discographyMatch.js";
import { probeAudioTags, type AudioFileTags } from "./ffprobe.js";

/**
 * Which album a folder of a downloaded discography is, told by the tags of its files. discographyMatch.ts reads the folder's
 * NAME; a folder named "CD1 - misc rips", "Disc 2" or "queen_ii_final" says nothing there, while its files' album tag does.
 * Lidarr identifies an album's files by their tags, so this is the second step of the same job: only a folder the name step left
 * `unmatched` or `ambiguous` is looked at, and what the tags say never overrides a name that already said.
 *
 * The same strictness as the name step: the tag's album must be the artist's album word for word (editions and rip tags aside),
 * and its artist must be the library artist (a "Various Artists" compilation is another artist's album). Where the tags are no
 * better than the name (no tag, a different artist, several albums in one folder) the folder is left as it was.
 */

/**
 * Files read per folder: every audio file of it, up to this many. The folders looked at here are the ones whose NAME says nothing
 * ("misc rips", "B-sides"), which are the likeliest to hold tracks of several albums, so a few files cannot speak for the folder:
 * all of them must agree. Past the cap the files read are spread evenly over the folder, and the album must have about as many
 * tracks as the folder has files (see identifyFolderByTags).
 */
export const TAG_FILES_PER_FOLDER = 40;
/** Tag text is quoted in a reason (which is stored and sent in a notification) at most this long. */
const QUOTED_TAG_CHARS = 80;
/** Folders read per release: a discography of dozens of oddly named folders is for a manual import, not for hundreds of ffprobe runs. */
export const TAG_FOLDERS_PER_RELEASE = 12;
/** How long one file's tags may take. */
export const TAG_READ_TIMEOUT_MS = 10_000;
/** A probe that outlives its timeout by this much is given up on, so it cannot hold a tag slot for good (a share that went away). */
const TAG_READ_GRACE_MS = 5_000;
/** Folders in a row whose files could not be read at all (no ffprobe, a dead share): the step stops, the rest are left to their names. */
const GIVE_UP_AFTER_UNREADABLE_FOLDERS = 3;

/** What one file's tags say about its album. */
export interface FileAlbumTags {
  album: string | null;
  /** The album artist when the file has one, else the track's artist. */
  artist: string | null;
  /** The year of the release date. */
  year: number | null;
  /** The disc this file is on and how many discs the release has. */
  disc: number | null;
  discTotal: number | null;
  /** The track's number on its disc and how many tracks the disc has, when the file says. */
  track?: number | null;
  trackTotal?: number | null;
}

/** Reads one file's tags; null when it cannot (never throws). Injected so the decision needs no ffprobe. */
export type TagReader = (file: string) => Promise<FileAlbumTags | null>;

/** A folder of the download with the audio files in it. */
export interface TagFolder extends AlbumFolder {
  audioFiles: string[];
}

export interface TagMatchOptions {
  /** The artist of the library title. */
  artist: string;
  /** The download's own folder. Tracks lying directly in it are loose: they are never judged by their tags. */
  releaseDir?: string;
  /** The folder of a file the admin picked (a manual import): read first, and a disc of an album is not held back for want of its other discs. */
  onlyFolder?: string;
  maxFolders?: number;
  filesPerFolder?: number;
}

export interface TagMatchResult {
  /** The name step's matches, with the folders the tags settled put in their place. */
  matches: Map<string, FolderMatch>;
  /** Folders now matched to an album by their tags. */
  identified: number;
  /** Folders whose files were read. */
  probed: number;
}

// ---- reading -----------------------------------------------------------------------------------------------------------

const YEAR = /(?<!\d)((?:19|20)\d{2})(?!\d)/;

/** The tags of a file as the matcher uses them, from what ffprobe found. Null when it found none of an album. */
export function fileAlbumTagsFrom(tags: AudioFileTags | null): FileAlbumTags | null {
  if (!tags) return null;
  const year = YEAR.exec(tags.date ?? "")?.[1];
  return {
    album: tags.album,
    artist: tags.albumArtist ?? tags.artist,
    year: year ? Number(year) : null,
    disc: tags.disc ?? null,
    discTotal: tags.discTotal ?? null,
    // Only when the file has them: a file with no track tag reads as it always did.
    ...(tags.track != null ? { track: tags.track } : {}),
    ...(tags.trackTotal != null ? { trackTotal: tags.trackTotal } : {}),
  };
}

/**
 * A tag's text as it is quoted in a reason. A reason is stored on the queue row, shown on the queue page and sent in a
 * notification, and a tag is whatever the release's uploader wrote (ffprobe hands over up to 10 MB of it): it is cut short, its
 * control characters and line breaks become spaces, and an "@" is spelled out so that "@everyone" mentions nobody.
 */
export function quotedTag(text: string): string {
  const clean = text
    .slice(0, QUOTED_TAG_CHARS * 2)
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]+/gu, " ")
    .replace(/@/g, "(at)")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...clean];
  return chars.length > QUOTED_TAG_CHARS ? `${chars.slice(0, QUOTED_TAG_CHARS - 3).join("")}...` : clean;
}

/** `work`, or null once `ms` have passed (the work is not cancelled; its late answer is dropped). */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads one audio file's tags with ffprobe, under the slot every tag job in the process shares (an import's tag writes, a library
 * retag), so a discography of many folders cannot pile up probes beside them. Null when ffprobe is missing, fails or does not answer
 * in time. This is not the "Analyse video files" switch's to turn off: it reads audio tags that decide which album a folder is.
 */
export const readFileAlbumTags: TagReader = async (file) => {
  try {
    const tags = await withTagSlot(undefined, () => withDeadline(probeAudioTags(file, { timeoutMs: TAG_READ_TIMEOUT_MS, quiet: true }), TAG_READ_TIMEOUT_MS + TAG_READ_GRACE_MS));
    return fileAlbumTagsFrom(tags);
  } catch {
    return null;
  }
};

/** The files to read of a folder: all of them when there are no more than `count`, else `count` spread evenly over it (the first and the last among them). */
export function sampleFiles(files: string[], count = TAG_FILES_PER_FOLDER): string[] {
  const sorted = [...files].sort();
  if (sorted.length <= count) return sorted;
  const picks = Array.from({ length: count }, (_, i) => Math.round((i * (sorted.length - 1)) / Math.max(1, count - 1)));
  return [...new Set(picks)].map((i) => sorted[i]);
}

// ---- deciding ----------------------------------------------------------------------------------------------------------

// "Album (Disc 1)", "Album [CD2]", "Album - Disc 1 of 2", "Album CD1": the disc is the disc's, not the album's name.
const DISC_MARKER = /[[(]\s*(?:cd|dis[ck])\s*\d+(?:\s*(?:of|\/)\s*\d+)?\s*[\])]|(?<![a-z0-9])(?:cd|dis[ck])[\s._-]*\d+(?:\s*(?:of|\/)\s*\d+)?(?![0-9])/gi;

function isVariousArtists(artist: string): boolean {
  const joined = albumWords(artist).join("");
  return joined === "variousartists" || joined === "various" || joined === "va";
}

/** Whether a tag's artist is the library artist: the same words, or the same letters ("AC/DC" and "ACDC", "R.E.M." and "REM"). */
function sameArtist(tagArtist: string, libraryArtist: string): boolean {
  const a = albumWords(tagArtist);
  const b = albumWords(libraryArtist);
  return sameWords(a, b) || (a.length > 0 && b.length > 0 && a.join("") === b.join(""));
}

interface FolderIdentity {
  albumId: number;
  /** The disc every file read is on; null when they carry none or are on several. */
  disc: number | null;
  /** The number of discs the tags say the release has. */
  discTotal: number | null;
  /** The files read are on more than one disc: the folder holds several discs itself. */
  severalDiscs: boolean;
  /** How many tracks the files' tags say the disc has; null when they say none or disagree. */
  trackTotal: number | null;
  /** The track numbers of the folder's files, when every file of it was read and has one. */
  trackNumbers: number[] | null;
}

type TagVerdict = ({ kind: "album" } & FolderIdentity) | { kind: "unmatched"; reason: string } | { kind: "ambiguous"; reason: string };

/**
 * More files than the album has tracks that a folder may hold and still be the album: the tags say how many discs there are, and
 * a disc more than the tracks (a bonus disc, a hidden track) is allowed; a one-disc album gets a few for hidden tracks.
 */
function filesAllowedFor(trackCount: number, discTotal: number | null): number {
  return trackCount + (discTotal != null && discTotal > 1 ? Math.ceil(trackCount / discTotal) : 3);
}

/**
 * What the tags of a folder's files say. Every file must name an album and the artist, the artist must be the library's, and all
 * the files must name one album (a file of another makes the folder ambiguous: it holds tracks of different albums); that album must
 * be one of the artist's (a year breaks a tie between two of one title). `fileCount` is how many audio files the folder holds; when
 * that is more than the files read (a folder past the cap) the album has to have about that many tracks, or the unread files could
 * be anything.
 */
export function identifyFolderByTags(files: FileAlbumTags[], artist: string, albums: MatchableAlbum[], fileCount = files.length): TagVerdict {
  if (files.length === 0) return { kind: "unmatched", reason: "it has no tags to read" };
  if (files.some((f) => !f.album)) return { kind: "unmatched", reason: "a file of it has no album tag" };
  for (const f of files) {
    if (!f.artist) return { kind: "unmatched", reason: "a file of it names no artist" };
    if (isVariousArtists(f.artist)) return { kind: "unmatched", reason: `it is tagged as a compilation by "${quotedTag(f.artist)}", not an album of ${artist}` };
    if (!sameArtist(f.artist, artist)) return { kind: "unmatched", reason: `it is tagged as an album by "${quotedTag(f.artist)}", not by ${artist}` };
  }
  // The album a file names, with a disc marker taken off ("Album (Disc 2)" is Album); the whole title is tried first.
  const readings = files.map((f) => ({ whole: albumWords(f.album!), plain: albumWords(f.album!.replace(DISC_MARKER, " ")) }));
  const keys = new Set(readings.map((r) => (r.plain.length > 0 ? r.plain : r.whole).join(" ")));
  if (keys.size > 1) {
    const names = [...new Set(files.map((f) => `"${quotedTag(f.album!)}"`))];
    return { kind: "ambiguous", reason: `it holds tracks of different albums (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", ..." : ""})` };
  }
  const tagged = files[0].album!;
  const reading = readings[0];
  let matches = albums.filter((album) => {
    const words = albumWords(album.title);
    return words.length > 0 && (sameWords(reading.whole, words) || sameWords(reading.plain, words));
  });
  if (matches.length === 0) return { kind: "unmatched", reason: `its album tag "${quotedTag(tagged)}" is not the name of any album of this artist` };
  if (matches.length > 1) {
    const years = new Set(files.flatMap((f) => (f.year != null ? [f.year] : [])));
    const byYear = years.size === 1 ? matches.filter((album) => albumYear(album.releaseDate) === [...years][0]) : [];
    if (byYear.length !== 1) {
      return { kind: "ambiguous", reason: `its album tag "${quotedTag(tagged)}" fits ${matches.length} albums and its year tag does not tell which` };
    }
    matches = byYear;
  }
  const discs = new Set(files.flatMap((f) => (f.disc != null ? [f.disc] : [])));
  const totals = new Set(files.flatMap((f) => (f.discTotal != null ? [f.discTotal] : [])));
  const discTotal = totals.size === 1 ? [...totals][0] : null;
  if (fileCount > files.length) {
    // Part of the folder was not read. It is the album only if it is no bigger than the album could be.
    const tracks = Number(matches[0].trackCount) || 0;
    if (tracks <= 0) return { kind: "ambiguous", reason: `it holds ${fileCount} files, more than were read, and the album's tracks are not known to tell whether they are all of it` };
    const allowed = filesAllowedFor(tracks, discTotal);
    if (fileCount > allowed) return { kind: "ambiguous", reason: `it holds ${fileCount} files, and "${matches[0].title}" has ${tracks} tracks: it looks like more than the one album` };
  }
  const trackTotals = new Set(files.flatMap((f) => (f.trackTotal != null ? [f.trackTotal] : [])));
  return {
    kind: "album",
    albumId: matches[0].id,
    disc: discs.size === 1 && files.every((f) => f.disc != null) ? [...discs][0] : null,
    discTotal,
    severalDiscs: discs.size > 1,
    trackTotal: trackTotals.size === 1 ? [...trackTotals][0] : null,
    trackNumbers: files.length === fileCount && files.every((f) => f.track != null) ? files.map((f) => f.track!) : null,
  };
}

function withTagReason(previous: FolderMatch, kind: "unmatched" | "ambiguous", reason: string): FolderMatch {
  const was = previous.kind === "unmatched" || previous.kind === "ambiguous" || previous.kind === "duplicate" ? previous.reason : "";
  return { kind, reason: was ? `${was}; by its tags: ${reason}` : `by its tags: ${reason}` };
}

/**
 * The second step of telling a discography's folders apart. The name step's matches come in; of the folders it left `unmatched` or
 * `ambiguous` (only those: a folder it matched is never read, and a tag never overrides a name) the first dozen have the tags of
 * their files read (every file, up to TAG_FILES_PER_FOLDER), and each is matched to one of the artist's albums when the tags of all
 * of them say so.
 *
 * Folders of one album laid side by side ("Album CD1", "Album CD2": the name step leaves them whole) are one album when the tags
 * agree on it: the same artist and album, different disc numbers running from 1, and as many folders as the tags say there are discs.
 * They are matched together (each carries the list of the discs) and placed as one album. A folder whose tags are not enough, a
 * file with the wrong artist, a "Various Artists" compilation, several albums in one folder, or tracks lying loose in the release's
 * own folder stay as the name step left them.
 */
export async function matchFoldersByTags(
  folders: TagFolder[],
  albums: MatchableAlbum[],
  nameMatches: Map<string, FolderMatch>,
  tagsOf: TagReader,
  options: TagMatchOptions
): Promise<TagMatchResult> {
  const matches = new Map(nameMatches);
  const same = (a: string, b: string) => path.resolve(a) === path.resolve(b);
  const unsettled = (folder: TagFolder): boolean => {
    const kind = matches.get(folder.path)?.kind;
    return (kind === "unmatched" || kind === "ambiguous") && folder.audioFiles.length > 0 && !(options.releaseDir && same(folder.path, options.releaseDir));
  };
  // The folder the admin picked first, so that the cap never leaves it out.
  const candidates = folders
    .filter(unsettled)
    .sort((a, b) => Number(!!options.onlyFolder && same(b.path, options.onlyFolder)) - Number(!!options.onlyFolder && same(a.path, options.onlyFolder)) || (a.path < b.path ? -1 : 1));
  // A manual import whose folder the name already settled has nothing to ask the tags: no file is read for the other folders.
  if (options.onlyFolder && !candidates.some((folder) => same(folder.path, options.onlyFolder!))) return { matches, identified: 0, probed: 0 };

  const identities = new Map<string, FolderIdentity>();
  const refused = new Map<string, { kind: "unmatched" | "ambiguous"; reason: string }>();
  let probed = 0;
  let unreadableInARow = 0;
  for (const folder of candidates) {
    if (probed >= (options.maxFolders ?? TAG_FOLDERS_PER_RELEASE)) break;
    probed++;
    const read = await Promise.all(
      sampleFiles(folder.audioFiles, options.filesPerFolder).map(async (file) => {
        try {
          return await tagsOf(file);
        } catch {
          return null;
        }
      })
    );
    const readable = read.filter((tags): tags is FileAlbumTags => tags !== null);
    if (readable.length === 0) {
      // No ffprobe, or a download that cannot be read: the rest would fail the same way, slowly.
      if (++unreadableInARow >= GIVE_UP_AFTER_UNREADABLE_FOLDERS) break;
      continue;
    }
    unreadableInARow = 0;
    // A file that could not be read leaves the folder to its name: half a picture is not enough to name an album.
    if (readable.length < read.length) continue;
    const verdict = identifyFolderByTags(readable, options.artist, albums, folder.audioFiles.length);
    if (verdict.kind === "album") identities.set(folder.path, verdict);
    else refused.set(folder.path, verdict);
  }

  // Folders that the tags identify as one album.
  const byAlbum = new Map<number, TagFolder[]>();
  for (const folder of candidates) {
    const identity = identities.get(folder.path);
    if (identity) byAlbum.set(identity.albumId, [...(byAlbum.get(identity.albumId) ?? []), folder]);
  }
  const heldByName = new Set(Array.from(matches.values()).flatMap((m) => (m.kind === "album" ? [m.albumId] : [])));
  let identified = 0;
  for (const [albumId, group] of byAlbum) {
    const album = albums.find((a) => a.id === albumId)!;
    const settle = (kind: "unmatched" | "ambiguous" | "duplicate", reason: string, folder: TagFolder) => {
      matches.set(folder.path, kind === "duplicate" ? { kind, reason, albumId } : withTagReason(matches.get(folder.path)!, kind, reason));
    };
    if (heldByName.has(albumId)) {
      // Its name already told which folder is this album; another folder of the same album is a second copy of it.
      for (const folder of group) settle("duplicate", `"${folder.name}" is tagged as "${album.title}", which another folder named for it holds`, folder);
      continue;
    }
    const identityOf = (folder: TagFolder) => identities.get(folder.path)!;
    if (group.length === 1) {
      const folder = group[0];
      const { disc, discTotal, severalDiscs } = identityOf(folder);
      // One disc of an album, tagged as one of several and without the others in folders of their own: filing it would mark
      // the album complete with half of it. (A hand-picked folder is the admin's own choice.)
      if (!options.onlyFolder && !severalDiscs && disc != null && discTotal != null && discTotal > 1) {
        settle("ambiguous", `"${folder.name}" holds disc ${disc} of the ${discTotal} of "${album.title}" and the other discs are not in folders of their own`, folder);
        continue;
      }
      matches.set(folder.path, { kind: "album", albumId, target: album.target, by: "tags" });
      identified++;
      continue;
    }
    const discs = discsOfGroup(group.map((folder) => ({ folder, ...identityOf(folder) })), options.onlyFolder != null);
    if (typeof discs === "string") {
      for (const folder of group) settle("ambiguous", `${group.length} folders are tagged as "${album.title}" and are not its discs: ${discs}`, folder);
      continue;
    }
    for (const folder of group) {
      matches.set(folder.path, { kind: "album", albumId, target: album.target, by: "tags", discs });
      identified++;
    }
  }

  for (const [folderPath, verdict] of refused) {
    const previous = matches.get(folderPath)!;
    // A mixed folder is ambiguous whatever the name said; a folder the tags merely do not name stays as it was, with the reason.
    matches.set(folderPath, withTagReason(previous, verdict.kind === "ambiguous" || previous.kind === "ambiguous" ? "ambiguous" : "unmatched", verdict.reason));
  }
  return { matches, identified, probed };
}

/**
 * The discs of an album found in several folders, in order, or why they are not that. The folders must be one disc each (not a
 * folder that holds several), with different disc numbers running 1, 2, 3 ..., and when the tags say how many discs the release has
 * it is as many as there are folders. Each disc but the last must also be whole: the import counts a disc's tracks after the files
 * of the discs before it, so a disc that is short of a track (a bad rip) would put every later disc one title off.
 */
function discsOfGroup(group: ({ folder: TagFolder } & FolderIdentity)[], handPicked: boolean): DiscFolder[] | string {
  if (group.some((g) => g.severalDiscs || g.disc == null)) return "a folder holds several discs or names none";
  // Placed from the files lying in each folder: a folder that keeps its tracks in subfolders would be placed without them.
  if (group.some((g) => g.folder.audioFiles.some((file) => path.resolve(path.dirname(file)) !== path.resolve(g.folder.path)))) return "a folder keeps its tracks in subfolders";
  const numbers = group.map((g) => g.disc!).sort((a, b) => a - b);
  if (new Set(numbers).size !== numbers.length) return "two of them are the same disc";
  if (numbers.some((n, i) => n !== i + 1)) return `their discs (${numbers.join(", ")}) do not run from 1 without a gap`;
  const totals = new Set(group.flatMap((g) => (g.discTotal != null ? [g.discTotal] : [])));
  if (totals.size > 1) return "they disagree on how many discs there are";
  if (totals.size === 1 && [...totals][0] !== group.length && !handPicked) return `the tags say ${[...totals][0]} discs and ${group.length} are here`;
  // A disc's tracks are counted after the files of the discs before it (the last disc's count moves nothing). Where the tags give the
  // number of tracks a disc has, or number its files, an earlier disc that disagrees is short of a track or holds an extra one.
  const ordered = [...group].sort((a, b) => a.disc! - b.disc!);
  const filesInGroup = ordered.reduce((sum, g) => sum + g.folder.audioFiles.length, 0);
  for (const g of ordered.slice(0, -1)) {
    const files = g.folder.audioFiles.length;
    // The same total on every disc that is the album's whole count ("1/24" on a disc of twelve) says nothing of this disc.
    const albumWide = g.trackTotal === filesInGroup && ordered.every((o) => o.trackTotal === g.trackTotal);
    if (g.trackTotal != null && g.trackTotal !== files && !albumWide) return `disc ${g.disc} ("${g.folder.name}") has ${files} files and its tags say it has ${g.trackTotal} tracks`;
    if (g.trackNumbers && [...g.trackNumbers].sort((a, b) => a - b).some((n, i) => n !== i + 1)) {
      return `the track numbers in disc ${g.disc} ("${g.folder.name}") do not run from 1 to ${files} without a gap`;
    }
  }
  return group
    .map((g) => ({ path: g.folder.path, disc: g.disc! }))
    .sort((a, b) => a.disc - b.disc);
}
