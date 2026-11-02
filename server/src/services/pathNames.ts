/** The longest a single file or folder name may be on the common filesystems, in bytes (ext4, XFS,
 * NTFS and most network shares). A longer one fails the move with ENAMETOOLONG. */
export const MAX_NAME_BYTES = 255;

/** `text` cut to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateToBytes(text: string, maxBytes: number): string {
  let out = "";
  let bytes = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > maxBytes) break;
    out += ch;
    bytes += size;
  }
  return out;
}

/**
 * `prefix` + `name` as one file name that fits MAX_NAME_BYTES: the name's stem is cut when it would
 * not, and its extension kept. The recycle bin puts a timestamp and a random id in front of every
 * name, so a library file near the limit would otherwise be too long for the bin.
 */
export function fitFileName(prefix: string, name: string): string {
  if (Buffer.byteLength(prefix + name) <= MAX_NAME_BYTES) return prefix + name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && Buffer.byteLength(name) - Buffer.byteLength(name.slice(0, dot)) <= 16 ? name.slice(dot) : "";
  const stem = extension ? name.slice(0, dot) : name;
  return prefix + truncateToBytes(stem, MAX_NAME_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(extension)) + extension;
}
