import fs from "node:fs";
import { log } from "./logger.js";
import { getSetting } from "./settingsStore.js";

/**
 * Applies the configured chmod (and, only when running as root, chown) to a just-created file or
 * folder — Sonarr/Radarr's "File Management > Permissions" setting, which AoNarr had no equivalent
 * of: every imported file previously landed with whatever the container's default umask gave it,
 * which is wrong the moment another app (Plex, Jellyfin) reads the library under a different
 * uid/gid. Best-effort and silent on failure (e.g. a bind mount that doesn't support chmod, or a
 * non-root container missing permission to chown) — a permissions tweak failing shouldn't fail the
 * import itself.
 */
export function applyConfiguredPermissions(targetPath: string, isDirectory: boolean): void {
  if (getSetting("setPermissionsEnabled") !== "1") return;
  const mode = getSetting(isDirectory ? "folderChmod" : "fileChmod");
  if (mode && /^[0-7]{3,4}$/.test(mode)) {
    try {
      fs.chmodSync(targetPath, parseInt(mode, 8));
    } catch (err) {
      log.warn(`[permissions] chmod ${mode} failed for ${targetPath}:`, (err as Error).message);
    }
  }

  if (typeof process.getuid === "function" && process.getuid() === 0) {
    const uid = getSetting("chownUid");
    const gid = getSetting("chownGid");
    if (uid && gid) {
      try {
        fs.chownSync(targetPath, Number(uid), Number(gid));
      } catch (err) {
        log.warn(`[permissions] chown ${uid}:${gid} failed for ${targetPath}:`, (err as Error).message);
      }
    }
  }
}
