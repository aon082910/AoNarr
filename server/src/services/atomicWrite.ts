import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { applyConfiguredPermissions } from "./filePermissions.js";

/**
 * Metadata files (NFO, artwork) are written under a temporary name beside their destination and renamed into place, so a
 * crash, a full disk or a dying download never leaves a half-written poster or NFO for Kodi to read. The importer's
 * `.aonarr-tmp-` prefix is used on purpose: its stale-temp sweep then collects a temp a killed run left behind.
 */
const TEMP_PREFIX = ".aonarr-tmp-";

/**
 * The temp name is the prefix, 12 hex digits and only the destination's extension, never its base name: a destination
 * whose name just fits the file system (255 bytes; a CJK name costs 3 bytes a character) would otherwise get a temp name
 * 25 bytes too long and fail where the direct write that came before this worked. The extension is at most a few bytes
 * for any real file name, and one that is longer than 16 bytes is not carried over (it is no extension of a picture or an NFO).
 */
function tempNextTo(dest: string): string {
  const ext = path.extname(dest);
  return path.join(path.dirname(dest), `${TEMP_PREFIX}${crypto.randomBytes(6).toString("hex")}${ext.length <= 16 ? ext : ""}`);
}

export function writeFileAtomicSync(dest: string, data: string | Buffer): void {
  const tmp = tempNextTo(dest);
  try {
    fs.writeFileSync(tmp, data, { flag: "wx" });
    applyConfiguredPermissions(tmp, false);
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export async function writeFileAtomic(dest: string, data: Buffer): Promise<void> {
  const tmp = tempNextTo(dest);
  try {
    await fsp.writeFile(tmp, data, { flag: "wx" });
    applyConfiguredPermissions(tmp, false);
    await fsp.rename(tmp, dest);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
