/**
 * Looks inside an NZB before a download client gets it. The adapters already fetch the NZB themselves (validateNzb),
 * so the inspection runs on those bytes: one download of the file, no second request to the indexer.
 *
 * Pure: bytes in, facts and a verdict out. An NZB lists the posts of a release, so file names, sizes and a
 * password note are all there is to judge by; the checks catch what a name cannot show: a release that holds only an
 * .nfo, a clip, a password, a program.
 */

export interface NzbFile {
  name: string;
  bytes: number;
}

export interface NzbInfo {
  files: NzbFile[];
  /** The password the poster put in the NZB's meta data, if any. */
  password: string | null;
}

const ENTITIES: Record<string, string> = { "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">", "&apos;": "'", "&#39;": "'" };
const decode = (s: string) => s.replace(/&(?:quot|amp|lt|gt|apos|#39);/g, (m) => ENTITIES[m] ?? m);

/** The file name inside a post's subject (`"Name.mkv" yEnc (1/50)`), else the whole subject. */
export function fileNameFromSubject(subject: string): string {
  const quoted = /"([^"]+)"/.exec(subject);
  if (quoted) return quoted[1].trim();
  // `[01/10] - Name.part01.rar yEnc (1/50)`: the token with an extension, else everything before "yEnc".
  const before = subject.replace(/\s+yEnc\b.*$/i, "").replace(/^\s*\[\d+\/\d+\]\s*-?\s*/, "").trim();
  return before || subject.trim();
}

/** Samples under this are never a whole film or episode. */
export const SAMPLE_MAX_BYTES = 70 * 1_000_000;

/** The longest tag read: a real `<file ...>` or `<segment ...>` tag is a few hundred characters. */
const MAX_TAG_CHARS = 4096;

/** Index of the next `<name` tag at or after `from` (the name followed by a space, `>` or `/`), else -1. A plain scan, so
 * a hostile file with thousands of unclosed tags costs one pass, not one pass per tag. */
function nextTag(xml: string, name: string, from: number): number {
  const needle = `<${name}`;
  for (let at = xml.indexOf(needle, from); at >= 0; at = xml.indexOf(needle, at + needle.length)) {
    const c = xml.charCodeAt(at + needle.length);
    if (c === 32 || c === 62 || c === 47 || c === 9 || c === 10 || c === 13) return at;
  }
  return -1;
}

export function parseNzb(xml: string): NzbInfo {
  const files: NzbFile[] = [];
  let pos = 0;
  for (;;) {
    const open = nextTag(xml, "file", pos);
    if (open < 0) break;
    const tagEnd = xml.indexOf(">", open);
    if (tagEnd < 0) break;
    const close = xml.indexOf("</file>", tagEnd);
    if (close < 0) break;
    pos = close + 7;
    if (tagEnd - open > MAX_TAG_CHARS) continue;
    const subject = /\bsubject="([^"]*)"/.exec(xml.slice(open, tagEnd))?.[1] ?? "";
    let bytes = 0;
    for (let seg = nextTag(xml, "segment", tagEnd); seg >= 0 && seg < close; seg = nextTag(xml, "segment", seg + 8)) {
      const end = xml.indexOf(">", seg);
      if (end < 0 || end > close) break;
      if (end - seg > MAX_TAG_CHARS) continue;
      const n = /\bbytes="(\d+)"/.exec(xml.slice(seg, end));
      if (n) bytes += Number(n[1]);
    }
    files.push({ name: fileNameFromSubject(decode(subject)), bytes });
  }
  let password: string | null = null;
  const meta = xml.indexOf('type="password"');
  if (meta >= 0) {
    const from = xml.indexOf(">", meta);
    const to = from >= 0 ? xml.indexOf("<", from) : -1;
    if (from >= 0 && to > from && to - from <= MAX_TAG_CHARS) password = decode(xml.slice(from + 1, to).trim()) || null;
  }
  return { files, password };
}

const EXECUTABLE = /\.(?:exe|scr|bat|cmd|com|msi|lnk|vbs|ps1|jar|apk|dmg|pif)$/i;
/** Companion files that are not the release: repair data, text, pictures, checksums. */
const COMPANION = /\.(?:par2|nfo|sfv|srr|srs|txt|jpe?g|png|gif|nzb|url|diz|db|idx|sub|srt|ass|md5|sha1|log|cue|m3u|xml)$/i;
const SAMPLE_NAME = /(?:^|[^a-z0-9])sample(?:[^a-z0-9]|$)/i;
const PAYLOAD = /\.(?:mkv|mp4|m4v|avi|mov|wmv|ts|m2ts|mpe?g|webm|flv|iso|rar|7z|zip|r\d{2,3}|z\d{2}|\d{3}|part\d+\.rar)$/i;

export interface NzbVerdict {
  code: "executable" | "no-payload" | "too-small";
  reason: string;
}

const gb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

type FileKind = "executable" | "companion" | "sample" | "payload" | "unknown";

/**
 * What one file in the NZB is. A sample is a file with the word in its name AND under the sample size: a film called
 * "Sample Size" is whole. A name with no extension we know (an obfuscated post: `9f3c1a...`) is "unknown": it may well
 * be the video, so it is never held against the release.
 */
function kindOf(f: NzbFile): FileKind {
  if (EXECUTABLE.test(f.name)) return "executable";
  if (COMPANION.test(f.name)) return "companion";
  if (SAMPLE_NAME.test(f.name) && f.bytes < SAMPLE_MAX_BYTES) return "sample";
  if (PAYLOAD.test(f.name)) return "payload";
  return "unknown";
}

/** Bytes of what is, or may be, the release itself: video and archives and files we cannot read the name of. */
export function payloadBytes(info: NzbInfo): number {
  return info.files.filter((f) => ["payload", "unknown"].includes(kindOf(f))).reduce((sum, f) => sum + f.bytes, 0);
}

/**
 * The verdict on an NZB. `minPayloadBytes` is the least the release can hold and still be what it says (the size floor
 * for its quality and runtime); 0 skips the size rule. Not refused: a missing par2 (a clean post needs no repair), a
 * password in the NZB's meta data (the client unpacks with it), and a post whose file names are obfuscated.
 */
export function nzbVerdict(info: NzbInfo, opts: { minPayloadBytes?: number } = {}): NzbVerdict | null {
  const exe = info.files.find((f) => kindOf(f) === "executable");
  if (exe) return { code: "executable", reason: `The NZB contains a program (${exe.name})` };
  // Unreadable names are counted as payload for the size rule, but they cannot prove there is a video.
  const judged = info.files.filter((f) => kindOf(f) === "payload" || kindOf(f) === "unknown");
  if (judged.length === 0) return { code: "no-payload", reason: "The NZB holds no video or archive, only repair data, text or a sample" };
  const total = judged.reduce((sum, f) => sum + f.bytes, 0);
  const min = opts.minPayloadBytes ?? 0;
  if (min > 0 && total < min) return { code: "too-small", reason: `The NZB holds ${gb(total)} of video, under the ${gb(min)} this release needs` };
  return null;
}
