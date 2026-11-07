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

export function parseNzb(xml: string): NzbInfo {
  const files: NzbFile[] = [];
  const fileRe = /<file\b([^>]*)>([\s\S]*?)<\/file>/gi;
  for (let m = fileRe.exec(xml); m; m = fileRe.exec(xml)) {
    const subject = /\bsubject="([^"]*)"/i.exec(m[1])?.[1] ?? "";
    let bytes = 0;
    const segRe = /<segment\b[^>]*\bbytes="(\d+)"/gi;
    for (let s = segRe.exec(m[2]); s; s = segRe.exec(m[2])) bytes += Number(s[1]);
    files.push({ name: fileNameFromSubject(decode(subject)), bytes });
  }
  const pw = /<meta\s+[^>]*\btype="password"[^>]*>\s*([^<]*?)\s*</i.exec(xml)?.[1];
  return { files, password: pw ? decode(pw) : null };
}

const EXECUTABLE = /\.(?:exe|scr|bat|cmd|com|msi|lnk|vbs|ps1|jar|apk|dmg|pif)$/i;
/** Companion files that are not the release: repair data, text, pictures, checksums. */
const COMPANION = /\.(?:par2|nfo|sfv|srr|srs|txt|jpe?g|png|gif|nzb|url|diz|db|idx|sub|srt|ass|md5|sha1|log|cue|m3u|xml)$/i;
const SAMPLE_NAME = /(?:^|[^a-z0-9])sample(?:[^a-z0-9]|$)/i;
const PAYLOAD = /\.(?:mkv|mp4|m4v|avi|mov|wmv|ts|m2ts|mpe?g|webm|flv|iso|rar|7z|zip|r\d{2,3}|z\d{2}|\d{3}|part\d+\.rar)$/i;

export interface NzbVerdict {
  code: "password" | "executable" | "no-payload" | "too-small";
  reason: string;
}

const gb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

/** Bytes of what is the release itself: video and archives, without samples, repair data and text. */
export function payloadBytes(info: NzbInfo): number {
  return info.files.filter((f) => PAYLOAD.test(f.name) && !COMPANION.test(f.name) && !SAMPLE_NAME.test(f.name)).reduce((sum, f) => sum + f.bytes, 0);
}

/**
 * The verdict on an NZB. `minPayloadBytes` is the least the release can hold and still be what it says (a sample
 * limit, or the size floor for its quality and runtime); 0 skips the size rule. A missing par2 is no reason to
 * refuse: a clean post needs no repair.
 */
export function nzbVerdict(info: NzbInfo, opts: { minPayloadBytes?: number } = {}): NzbVerdict | null {
  if (info.password) return { code: "password", reason: "The NZB carries a password: the files are encrypted" };
  const exe = info.files.find((f) => EXECUTABLE.test(f.name));
  if (exe) return { code: "executable", reason: `The NZB contains a program (${exe.name})` };
  const payload = info.files.filter((f) => PAYLOAD.test(f.name) && !COMPANION.test(f.name) && !SAMPLE_NAME.test(f.name));
  if (payload.length === 0) return { code: "no-payload", reason: "The NZB holds no video or archive, only repair data, text or a sample" };
  const total = payload.reduce((sum, f) => sum + f.bytes, 0);
  const min = opts.minPayloadBytes ?? 0;
  if (min > 0 && total < min) return { code: "too-small", reason: `The NZB holds ${gb(total)} of video, under the ${gb(min)} this release needs` };
  return null;
}
