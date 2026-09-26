import fs from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { isUtf8 } from "node:buffer";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "../config.js";
import { log } from "./logger.js";
import { getMediaTypeConfig } from "./mediaTypes.js";

const ARCHIVE_EXTS = new Set([".zip", ".7z", ".rar"]);
const MAX_WALK_DEPTH = 4;

// Zip-bomb guards, checked against the archive's own listing before anything is written (and, for
// zip, enforced again while the bytes stream out, since a header can lie about its sizes).
const MAX_ENTRIES = 10_000;
const MAX_TOTAL_BYTES = 256 * 1024 ** 3;
const MAX_EXPANSION_RATIO = 100;
const EXPANSION_SLACK_BYTES = 64 * 1024 ** 2;
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 ** 2;
const MAX_LISTING_BYTES = 64 * 1024 ** 2;
const TOOL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Dropped next to an archive once it's been unpacked, so repeated import passes don't re-extract it. */
const SUCCESS_MARKER_SUFFIX = ".aonarr-extracted";
/** Dropped inside the folder an archive is unpacked into: archives in there are that archive's own
 * contents, and are never unpacked in turn. */
const OUTPUT_DIR_MARKER = ".aonarr-extracted-contents";

export interface ArchiveScope {
  /** This download's own location as its client reported it (queue.download_path, after remote
   * path mapping): the release's folder, or a single archive file. */
  downloadPath?: string | null;
  /** The grabbed release's title: finds this download's archives by name when the client reported
   * no usable path, and tells a release's own folder apart from a shared category folder. */
  releaseTitle?: string | null;
  /** The library type being imported. Archive formats that type imports as-is (ROM .zip/.7z) are
   * the media itself and are left alone. */
  mediaType?: string | null;
}

export interface UnpackResult {
  extracted: string[];
  failed: { archive: string; reason: string }[];
}

type Outcome = { ok: true } | { ok: false; reason: string };

/** Archives that failed to unpack, with the size/mtime their volumes had at the time: a broken,
 * encrypted or unsupported archive (or one whose tool isn't installed) was otherwise re-read on every
 * import pass. A changed or newly arrived volume (still downloading, re-downloaded, repaired) gets
 * another attempt. */
const failedArchives = new Map<string, { fingerprint: string; reason: string }>();
const MAX_REMEMBERED_FAILURES = 5_000;
const inFlight = new Map<string, Promise<Outcome>>();

function foldTokens(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['\u2019`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

const RELEASE_INFO_TOKEN =
  /^(?:(?:19|20)\d{2}|s\d{1,2}(?:e\d{1,3})*|\d{3,4}[pi]|complete|season|bluray|bdrip|brrip|web|webrip|webdl|hdtv|dvdrip|remux|x264|x265|h264|h265|hevc)$/;

const YEAR_TOKEN = /^(?:19|20)\d{2}$/;
const EPISODE_TOKEN = /^s\d{1,2}(?:e\d{1,3})*$/;

interface ReleaseTokens {
  /** Every word of the release name. */
  all: string[];
  /** The title part in front of the first year/episode/quality tag ("movie name" out of
   * "Movie.Name.2020.1080p.BluRay-GRP"). */
  lead: string[];
  /** What tells this release apart from the same title's other episodes, seasons or films: its
   * SxxEyy/Sxx tags (or else its year and air date), plus bare numbers in the title ("Show - 05"). */
  ids: string[];
}

function releaseTokens(releaseTitle: string | null | undefined): ReleaseTokens {
  if (!releaseTitle) return { all: [], lead: [], ids: [] };
  const raw = foldTokens(releaseTitle.replace(/^\s*(?:\[[^\]]*\]\s*)+/, ""));
  const stop = raw.findIndex((t) => RELEASE_INFO_TOKEN.test(t));
  const leadRaw = stop === -1 ? raw : raw.slice(0, stop);
  const lead = leadRaw.filter((t) => t.length >= 3);
  const ids = new Set(raw.filter((t) => EPISODE_TOKEN.test(t)));
  if (ids.size === 0) {
    raw.forEach((t, i) => {
      if (!YEAR_TOKEN.test(t)) return;
      ids.add(t);
      const [month, day] = [raw[i + 1] ?? "", raw[i + 2] ?? ""];
      if (/^\d{1,2}$/.test(month) && /^\d{1,2}$/.test(day)) ids.add(month).add(day);
    });
  }
  for (const t of leadRaw) if (/^\d+$/.test(t)) ids.add(t);
  return {
    all: raw.filter((t) => t.length >= 3),
    // A title made only of short words ("It", "Up") keeps them: with no lead at all, any other
    // film sharing its year, quality and group would pass for this release.
    lead: lead.length > 0 ? lead : leadRaw,
    ids: [...ids],
  };
}

/** A client's category folder ("tv", "movies") holds every download of that category, not just this one. */
function isSharedFolder(dir: string, release: ReleaseTokens): boolean {
  const dirTokens = new Set(foldTokens(path.basename(dir)));
  if (release.lead.length > 0) return !release.lead.some((t) => dirTokens.has(t));
  // No title words in front of the tags ("1917.2019..."): judge the folder by the whole release
  // name instead of trusting it to be the release's own.
  if (release.all.length === 0) return false;
  if (!release.ids.every((t) => dirTokens.has(t))) return true;
  return release.all.filter((t) => dirTokens.has(t)).length / release.all.length < 0.5;
}

function belongsToRelease(relativePath: string, release: ReleaseTokens): boolean {
  if (release.all.length === 0) return false;
  const have = new Set(foldTokens(relativePath));
  if (!release.lead.every((t) => have.has(t)) || !release.ids.every((t) => have.has(t))) return false;
  const needed = release.lead.length > 0 ? 0.5 : 0.8;
  return release.all.filter((t) => have.has(t)).length / release.all.length >= needed;
}

/** Only the first volume of a "name.partNN.rar" set is handed to unrar; it reads the rest itself. */
function isArchiveCandidate(fileName: string): boolean {
  if (!ARCHIVE_EXTS.has(path.extname(fileName).toLowerCase())) return false;
  const part = /\.part(\d+)\.rar$/i.exec(fileName);
  return !part || Number(part[1]) === 1;
}

function destinationFor(archivePath: string): string {
  const base = path.basename(archivePath).replace(/\.part\d+\.rar$/i, "").replace(/\.(zip|7z|rar)$/i, "");
  return path.join(path.dirname(archivePath), base);
}

async function exists(p: string): Promise<boolean> {
  return fsp.access(p).then(
    () => true,
    () => false
  );
}

async function walkArchives(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_WALK_DEPTH) return [];
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = new Set(entries.map((e) => e.name));
  if (names.has(OUTPUT_DIR_MARKER)) return [];
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walkArchives(full, depth + 1)));
    } else if (isArchiveCandidate(entry.name) && !names.has(entry.name + SUCCESS_MARKER_SUFFIX)) {
      found.push(full);
    }
  }
  return found;
}

async function findArchives(scope: ArchiveScope): Promise<string[]> {
  const downloadsRoot = path.resolve(config.downloadsDir);
  const release = releaseTokens(scope.releaseTitle);

  if (scope.downloadPath) {
    const reported = path.resolve(scope.downloadPath);
    const stat = await fsp.stat(reported).catch(() => null);
    if (stat?.isFile()) {
      return isArchiveCandidate(reported) && !(await exists(reported + SUCCESS_MARKER_SUFFIX)) ? [reported] : [];
    }
    if (stat?.isDirectory() && reported !== downloadsRoot) {
      const found = await walkArchives(reported);
      if (!isSharedFolder(reported, release)) return found;
      return found.filter((a) => belongsToRelease(path.relative(reported, a), release));
    }
    // A stale path, or the downloads root itself: find this release's archives by name instead.
  }
  if (scope.releaseTitle) {
    return (await walkArchives(downloadsRoot)).filter((a) => belongsToRelease(path.relative(downloadsRoot, a), release));
  }
  // A caller that doesn't say which download it is importing gets the old whole-directory sweep.
  if (scope.downloadPath === undefined) return walkArchives(downloadsRoot);
  return [];
}

interface Volume {
  name: string;
  size: number;
  mtimeMs: number;
}

/** The archive plus its sibling volumes ("x.part02.rar", "x.r00"), which together make up what it unpacks from. */
async function volumeSet(archivePath: string, own: fs.Stats): Promise<Volume[]> {
  const name = path.basename(archivePath);
  const volumes: Volume[] = [{ name, size: own.size, mtimeMs: own.mtimeMs }];
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const partSet = /^(.*)\.part\d+\.rar$/i.exec(name);
  let sibling: RegExp | null = null;
  if (partSet) sibling = new RegExp(`^${escape(partSet[1])}\\.part\\d+\\.rar$`, "i");
  else if (/\.rar$/i.test(name)) sibling = new RegExp(`^${escape(name.slice(0, -4))}\\.(?:r\\d{2,3}|s\\d{2})$`, "i");
  if (!sibling) return volumes;
  const dir = path.dirname(archivePath);
  for (const entry of (await fsp.readdir(dir).catch(() => [] as string[])).sort()) {
    if (entry === name || !sibling.test(entry)) continue;
    const stat = await fsp.stat(path.join(dir, entry)).catch(() => null);
    if (stat?.isFile()) volumes.push({ name: entry, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return volumes;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.ceil(bytes / 1024 ** 2)} MiB`;
}

function checkLimits(entryCount: number, totalBytes: number, archiveBytes: number): void {
  if (entryCount > MAX_ENTRIES) throw new Error(`archive holds ${entryCount} entries (limit ${MAX_ENTRIES})`);
  const allowed = Math.min(MAX_TOTAL_BYTES, archiveBytes * MAX_EXPANSION_RATIO + EXPANSION_SLACK_BYTES);
  if (totalBytes > allowed) {
    throw new Error(`archive would unpack to ${formatBytes(totalBytes)}, more than the ${formatBytes(allowed)} allowed for an archive of its size`);
  }
}

// ---- zip (streamed from disk, never loaded whole into memory) ----

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  isDirectory: boolean;
  isSymlink: boolean;
}

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  if (bytesRead !== length) throw new Error("zip archive is truncated");
  return buf;
}

async function readZipDirectory(fh: FileHandle, fileSize: number): Promise<ZipEntry[]> {
  const tailLength = Math.min(fileSize, 22 + 0xffff);
  if (tailLength < 22) throw new Error("not a zip archive");
  const tailStart = fileSize - tailLength;
  const tail = await readAt(fh, tailStart, tailLength);
  let eocd = -1;
  for (let i = tailLength - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive (no end-of-central-directory record)");

  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    if (tailStart + eocd < 20) throw new Error("corrupt zip64 archive (no locator)");
    const locator = await readAt(fh, tailStart + eocd - 20, 20);
    if (locator.readUInt32LE(0) !== 0x07064b50) throw new Error("corrupt zip64 archive (no locator)");
    const record = await readAt(fh, Number(locator.readBigUInt64LE(8)), 56);
    if (record.readUInt32LE(0) !== 0x06064b50) throw new Error("corrupt zip64 archive (no end record)");
    count = Number(record.readBigUInt64LE(32));
    cdSize = Number(record.readBigUInt64LE(40));
    cdOffset = Number(record.readBigUInt64LE(48));
  }
  if (count > MAX_ENTRIES) throw new Error(`archive holds ${count} entries (limit ${MAX_ENTRIES})`);
  if (cdSize > MAX_CENTRAL_DIRECTORY_BYTES || cdOffset + cdSize > fileSize) throw new Error("corrupt zip archive (bad central directory)");

  const cd = await readAt(fh, cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip archive (bad central directory entry)");
    const madeBy = cd.readUInt16LE(p + 4);
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc32 = cd.readUInt32LE(p + 16);
    let compressedSize = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    const nameLength = cd.readUInt16LE(p + 28);
    const extraLength = cd.readUInt16LE(p + 30);
    const commentLength = cd.readUInt16LE(p + 32);
    const externalAttributes = cd.readUInt32LE(p + 38);
    let localHeaderOffset = cd.readUInt32LE(p + 42);
    const nameBytes = cd.subarray(p + 46, p + 46 + nameLength);
    const name = flags & 0x800 || isUtf8(nameBytes) ? nameBytes.toString("utf8") : nameBytes.toString("latin1");

    let x = p + 46 + nameLength;
    const extraEnd = Math.min(x + extraLength, cd.length);
    while (x + 4 <= extraEnd) {
      const id = cd.readUInt16LE(x);
      const length = cd.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        const next = () => {
          if (q + 8 > x + 4 + length) throw new Error("corrupt zip64 extra field");
          const value = Number(cd.readBigUInt64LE(q));
          q += 8;
          return value;
        };
        if (size === 0xffffffff) size = next();
        if (compressedSize === 0xffffffff) compressedSize = next();
        if (localHeaderOffset === 0xffffffff) localHeaderOffset = next();
      }
      x += 4 + length;
    }

    const unixMode = madeBy >> 8 === 3 ? externalAttributes >>> 16 : 0;
    entries.push({
      name,
      flags,
      method,
      crc32,
      compressedSize,
      size,
      localHeaderOffset,
      isDirectory: /[/\\]$/.test(name) || (unixMode & 0o170000) === 0o040000,
      isSymlink: (unixMode & 0o170000) === 0o120000,
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Null for an entry naming no file at all ("./"); throws for one that would land outside `root`. */
function safeTarget(root: string, entryName: string): string | null {
  const normalized = entryName.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((s) => s !== "" && s !== ".");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || segments.includes("..")) {
    throw new Error(`archive entry "${entryName}" points outside its folder`);
  }
  if (segments.length === 0) return null;
  const target = path.resolve(root, ...segments);
  if (!target.startsWith(root + path.sep)) throw new Error(`archive entry "${entryName}" points outside its folder`);
  return target;
}

let crc32Table: Uint32Array | null = null;

/** CRC-32 (the zip polynomial) continuing from `previous`, same contract as zlib.crc32, which only
 * exists from Node 20.15 on. */
export function tableCrc32(data: Uint8Array, previous = 0): number {
  if (!crc32Table) {
    crc32Table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32Table[n] = c >>> 0;
    }
  }
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) crc = crc32Table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function crc32(data: Buffer, previous: number): number {
  return typeof zlib.crc32 === "function" ? zlib.crc32(data, previous) : tableCrc32(data, previous);
}

async function writeZipEntry(archivePath: string, fh: FileHandle, fileSize: number, entry: ZipEntry, target: string): Promise<void> {
  const header = await readAt(fh, entry.localHeaderOffset, 30);
  if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`corrupt zip archive (bad local header for "${entry.name}")`);
  const start = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (start + entry.compressedSize > fileSize) throw new Error(`zip archive is truncated ("${entry.name}")`);

  if (entry.compressedSize === 0) {
    if (entry.size !== 0) throw new Error(`corrupt zip archive ("${entry.name}" has no data)`);
    await fsp.writeFile(target, "");
    return;
  }

  let written = 0;
  let crc = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length;
      if (written > entry.size) {
        callback(new Error(`archive entry "${entry.name}" unpacks to more than its declared ${entry.size} bytes`));
        return;
      }
      // A throw here would escape the stream as an uncaught exception and leave the pipeline
      // (and the import waiting on it) unsettled forever.
      try {
        crc = crc32(chunk, crc);
      } catch (err) {
        callback(err as Error);
        return;
      }
      callback(null, chunk);
    },
  });
  const source = fs.createReadStream(archivePath, { start, end: start + entry.compressedSize - 1 });
  const out = fs.createWriteStream(target);
  if (entry.method === 8) await pipeline(source, zlib.createInflateRaw(), limiter, out);
  else await pipeline(source, limiter, out);
  if (written !== entry.size) throw new Error(`archive entry "${entry.name}" is truncated or corrupt`);
  // A stored entry has no inflate step to trip over damaged bytes; only the checksum catches them.
  if (crc !== entry.crc32) throw new Error(`archive entry "${entry.name}" failed its CRC check`);
}

async function extractZip(archivePath: string, destDir: string, archiveBytes: number): Promise<void> {
  const fh = await fsp.open(archivePath, "r");
  try {
    const entries = await readZipDirectory(fh, archiveBytes);
    checkLimits(entries.length, entries.reduce((sum, e) => sum + (e.isDirectory ? 0 : e.size), 0), archiveBytes);
    const root = path.resolve(destDir);
    const planned: { entry: ZipEntry; target: string }[] = [];
    for (const entry of entries) {
      const target = safeTarget(root, entry.name);
      if (!target || entry.isSymlink) continue;
      if (!entry.isDirectory) {
        if (entry.flags & 0x1) throw new Error("archive is password-protected");
        if (entry.method !== 0 && entry.method !== 8) throw new Error(`unsupported zip compression method ${entry.method}`);
      }
      planned.push({ entry, target });
    }
    for (const { entry, target } of planned) {
      if (entry.isDirectory) {
        await fsp.mkdir(target, { recursive: true });
        continue;
      }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await writeZipEntry(archivePath, fh, archiveBytes, entry, target);
    }
  } finally {
    await fh.close();
  }
}

// ---- rar / 7z (external tools) ----

/** A tool that ran and failed, with the exit code and stderr to tell why. */
class ToolError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string
  ) {
    super(message);
  }
}

function runTool(command: string, args: string[], captureStdout: boolean): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      // A password prompt on an open stdin pipe would never be answered and hang the import pass.
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"],
      timeout: TOOL_TIMEOUT_MS,
      windowsHide: true,
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let overflowed = false;
    let errTail = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      outBytes += chunk.length;
      if (outBytes > MAX_LISTING_BYTES) {
        // A cut-off listing would leave the entries past the cut out of the limits, and "x" would
        // still unpack them.
        overflowed = true;
        out.length = 0;
        child.kill();
        child.stdout?.destroy();
        reject(new Error(`the archive's listing is more than ${formatBytes(MAX_LISTING_BYTES)}, too large to check`));
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errTail = (errTail + chunk.toString("utf8")).slice(-2000);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      reject(err.code === "ENOENT" ? new Error(`the "${command}" program isn't installed`) : err);
    });
    child.on("close", (code, signal) => {
      if (overflowed) return;
      if (code === 0) {
        resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: errTail });
        return;
      }
      const detail = errTail.trim().split(/\r?\n/).filter(Boolean).pop();
      const message = signal ? `${command} was stopped (${signal})` : `${command} exited with code ${code}${detail ? `: ${detail}` : ""}`;
      reject(new ToolError(message, code, errTail));
    });
  });
}

/** Expects an all-volumes listing, where a file split across volumes has a header in each one:
 * those headers name the same entry, so each name counts once, at its largest size. */
interface Listing {
  entries: number;
  totalBytes: number;
  encrypted: boolean;
}

function parseUnrarListing(text: string): Listing {
  const sizes = new Map<string, number>();
  let current: string | null = null;
  let encrypted = false;
  for (const line of text.split(/\r?\n/)) {
    const name = /^\s*Name:\s(.*)$/.exec(line);
    if (name) {
      current = name[1];
      if (!sizes.has(current)) sizes.set(current, 0);
      continue;
    }
    const size = /^\s*Size:\s*(\d+)/.exec(line);
    if (size && current !== null) sizes.set(current, Math.max(sizes.get(current)!, Number(size[1])));
    if (/^\s*Flags:.*\bencrypted\b/.test(line)) encrypted = true;
  }
  let totalBytes = 0;
  for (const bytes of sizes.values()) totalBytes += bytes;
  return { entries: sizes.size, totalBytes, encrypted };
}

function parse7zListing(text: string): Listing {
  // Everything before the "----------" line describes the archive itself, not its contents.
  const separator = /^-{5,}\s*$/m.exec(text);
  if (!separator) return { entries: 0, totalBytes: 0, encrypted: false };
  let entries = 0;
  let totalBytes = 0;
  let encrypted = false;
  for (const line of text.slice(separator.index + separator[0].length).split(/\r?\n/)) {
    if (/^Path = /.test(line)) entries++;
    const size = /^Size = (\d+)/.exec(line);
    if (size) totalBytes += Number(size[1]);
    if (/^Encrypted = \+/.test(line)) encrypted = true;
  }
  return { entries, totalBytes, encrypted };
}

/** The tools are run with an empty password and no stdin, so an encrypted archive fails rather than
 * prompting: unrar exits 11, and 7z reports a wrong password (for encrypted file names, before
 * listing anything). */
function failedOnPassword(err: unknown, isRar: boolean): boolean {
  if (!(err instanceof ToolError)) return false;
  return isRar ? err.exitCode === 11 : /Wrong password|Cannot open encrypted archive/i.test(err.stderr);
}

async function extractWithTool(archivePath: string, destDir: string, ext: string, archiveBytes: number): Promise<void> {
  const isRar = ext === ".rar";
  const tool = isRar ? "unrar" : "7z";
  let listing: { stdout: string; stderr: string };
  try {
    // -v: without it unrar lists only the first volume, and entries starting in a later one went uncounted.
    listing = isRar
      ? await runTool(tool, ["lt", "-v", "-p-", archivePath], true)
      : await runTool(tool, ["l", "-slt", "-p", archivePath], true);
  } catch (err) {
    if (/isn't installed/.test((err as Error).message)) {
      throw new Error(
        `${isRar ? "RAR" : "7z"} archives can't be unpacked: the "${tool}" program isn't installed in this container — unpack it by hand and use Manual Import`
      );
    }
    if (failedOnPassword(err, isRar)) throw new Error("archive is password-protected");
    throw err;
  }
  // unrar still exits 0 when a volume is missing, having listed only the volumes before the gap:
  // the limits below would miss entries in the rest, which "x" could still reach and unpack unchecked.
  const missingVolume = isRar ? listing.stderr.split(/\r?\n/).find((line) => /Cannot find volume/i.test(line)) : undefined;
  if (missingVolume) throw new Error(`the RAR set is incomplete (${missingVolume.trim()})`);
  const { entries, totalBytes, encrypted } = isRar ? parseUnrarListing(listing.stdout) : parse7zListing(listing.stdout);
  if (entries === 0) throw new Error(`${tool} couldn't list the archive's contents`);
  if (encrypted) throw new Error("archive is password-protected");
  checkLimits(entries, totalBytes, archiveBytes);
  const args = isRar ? ["x", "-y", "-p-", archivePath, `${destDir}${path.sep}`] : ["x", "-y", "-p", `-o${destDir}`, archivePath];
  try {
    await runTool(tool, args, false);
  } catch (err) {
    if (failedOnPassword(err, isRar)) throw new Error("archive is password-protected");
    throw err;
  }
}

// ---- driver ----

function rememberFailure(archivePath: string, fingerprint: string, reason: string): void {
  failedArchives.delete(archivePath);
  if (failedArchives.size >= MAX_REMEMBERED_FAILURES) {
    const oldest = failedArchives.keys().next().value;
    if (oldest !== undefined) failedArchives.delete(oldest);
  }
  failedArchives.set(archivePath, { fingerprint, reason });
}

async function attemptExtraction(archivePath: string): Promise<Outcome> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(archivePath);
  } catch (err) {
    return { ok: false, reason: `can't read the archive: ${(err as Error).message}` };
  }
  // Covers every volume, not just the first: a RAR set tried while its later volumes were still
  // downloading must get another attempt once they finish, though part 1 itself never changes again.
  const volumes = await volumeSet(archivePath, stat);
  const fingerprint = volumes.map((v) => `${v.name}:${v.size}:${v.mtimeMs}`).join("/");
  const remembered = failedArchives.get(archivePath);
  if (remembered?.fingerprint === fingerprint) return { ok: false, reason: remembered.reason };

  const destDir = destinationFor(archivePath);
  const createdDest = !(await exists(destDir));
  const dirMarker = path.join(destDir, OUTPUT_DIR_MARKER);
  try {
    await fsp.mkdir(destDir, { recursive: true });
    await fsp.writeFile(dirMarker, path.basename(archivePath));
    const ext = path.extname(archivePath).toLowerCase();
    if (ext === ".zip") await extractZip(archivePath, destDir, stat.size);
    else await extractWithTool(archivePath, destDir, ext, volumes.reduce((sum, v) => sum + v.size, 0));
    await fsp.writeFile(archivePath + SUCCESS_MARKER_SUFFIX, new Date().toISOString());
    failedArchives.delete(archivePath);
    log.info(`[archiveExtract] unpacked ${path.basename(archivePath)} -> ${destDir}`);
    return { ok: true };
  } catch (err) {
    const reason = (err as Error).message;
    if (createdDest) await fsp.rm(destDir, { recursive: true, force: true }).catch(() => {});
    else await fsp.rm(dirMarker, { force: true }).catch(() => {});
    rememberFailure(archivePath, fingerprint, reason);
    log.warn(`[archiveExtract] failed to unpack "${archivePath}": ${reason}`);
    return { ok: false, reason };
  }
}

function extractOnce(archivePath: string): Promise<Outcome> {
  const running = inFlight.get(archivePath);
  if (running) return running;
  const attempt = attemptExtraction(archivePath).finally(() => inFlight.delete(archivePath));
  inFlight.set(archivePath, attempt);
  return attempt;
}

function formatsImportedAsIs(mediaType: string | null | undefined): Set<string> {
  if (!mediaType) return new Set();
  try {
    return new Set(getMediaTypeConfig(mediaType).extensions.filter((e) => ARCHIVE_EXTS.has(e)));
  } catch {
    return new Set();
  }
}

/**
 * Unpacks the .zip/.7z/.rar archives belonging to one completed download, so the ordinary
 * file-matching pass (which only looks at media file extensions) can find what's inside. Each
 * archive goes into a sibling folder named after it; archives inside that folder are left packed.
 * Never throws: a missing 7z/unrar binary, an encrypted, corrupt or oversized archive is logged
 * once, remembered so later passes don't retry it, and reported in `failed`.
 */
export async function unpackDownloadedArchives(scope: ArchiveScope = {}): Promise<UnpackResult> {
  const result: UnpackResult = { extracted: [], failed: [] };
  let archives: string[];
  try {
    archives = await findArchives(scope);
  } catch (err) {
    log.warn("[archiveExtract] couldn't look for archives:", (err as Error).message);
    return result;
  }
  const importedAsIs = formatsImportedAsIs(scope.mediaType);
  for (const archivePath of archives) {
    if (importedAsIs.has(path.extname(archivePath).toLowerCase())) continue;
    const outcome = await extractOnce(archivePath);
    if (outcome.ok) result.extracted.push(archivePath);
    else result.failed.push({ archive: archivePath, reason: outcome.reason });
  }
  return result;
}
