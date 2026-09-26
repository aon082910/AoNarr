import { db } from "../db/index.js";
import { log } from "./logger.js";
import { getSetting, setSetting } from "./settingsStore.js";
import { translateTrashFormat, type TrashCustomFormat } from "./trashFormats.js";

const CF_DIR: Record<"radarr" | "sonarr", string> = {
  radarr: "docs/json/radarr/cf",
  sonarr: "docs/json/sonarr/cf",
};

/** New formats synced in for the first time get scoped to the app's own library types rather than
 * left unrestricted, since a Radarr-only format (e.g. a resolution/size tier) has no reason to also
 * apply to TV libraries. A user can always broaden the scope afterward like any other format. */
const APP_MEDIA_TYPES: Record<"radarr" | "sonarr", string[]> = {
  radarr: ["movie", "ppv"],
  sonarr: ["series", "anime", "sports"],
};

const APP_LABELS: Record<"radarr" | "sonarr", string> = { radarr: "Radarr", sonarr: "Sonarr" };

/** The name a TRaSH format is stored under when its plain name already belongs to the other app's
 * copy. Anything that resolves a format by name for one app should try this before the plain name. */
export function appScopedFormatName(name: string, app: "radarr" | "sonarr"): string {
  return `${name} (${APP_LABELS[app]})`;
}

/**
 * TRaSH publishes separate Radarr and Sonarr files for many formats under the same name (BR-DISK,
 * LQ, x265 (HD), the streaming services...) but different trash_ids, and custom_formats.name is
 * UNIQUE, so whichever app syncs second would fail every shared name. When the plain name belongs to
 * another TRaSH-synced format, this one takes an app-suffixed name instead ("BR-DISK (Sonarr)"). A
 * name held by a format the admin created by hand (no trash_id) is left alone: null means no usable
 * name, and an already-synced format then keeps the name it has.
 */
async function pickFormatName(name: string, app: "radarr" | "sonarr", selfId: number | null): Promise<string | null> {
  const holder = (await db.prepare("SELECT id, trash_id FROM custom_formats WHERE name = ?").get(name)) as
    | { id: number; trash_id: string | null }
    | undefined;
  if (!holder || holder.id === selfId) return name;
  if (!holder.trash_id) return null;
  const suffixed = appScopedFormatName(name, app);
  const suffixedHolder = (await db.prepare("SELECT id FROM custom_formats WHERE name = ?").get(suffixed)) as { id: number } | undefined;
  return !suffixedHolder || suffixedHolder.id === selfId ? suffixed : null;
}

interface GithubContentEntry {
  name: string;
  download_url: string;
  type: string;
}

async function listTrashFiles(app: "radarr" | "sonarr"): Promise<GithubContentEntry[]> {
  const res = await fetch(`https://api.github.com/repos/TRaSH-Guides/Guides/contents/${CF_DIR[app]}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "AoNarr" },
  });
  if (!res.ok) throw new Error(`GitHub API request failed: HTTP ${res.status}`);
  const entries = (await res.json()) as GithubContentEntry[];
  return entries.filter((e) => e.type === "file" && e.name.endsWith(".json"));
}

/** Fetches every format file's raw JSON with a small concurrency cap — sequential would be slow
 * for a 100+ file directory, unbounded parallel would be rude to raw.githubusercontent.com. */
async function fetchAllWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface TrashSyncResult {
  added: number;
  updated: number;
  unsupported: string[];
  /** Formats that DID sync, but with one or more condition types silently dropped (e.g. a
   * QualityModifierSpecification alongside a translatable title condition) — as opposed to
   * `unsupported`, which is formats with nothing translatable at all. Surfaced in the log the same
   * way the paste-JSON import path already surfaces this to the admin directly. */
  partiallyUnsupported: { name: string; skipped: string[] }[];
  /** Formats that could not be written at all, with the reason. */
  failed: { name: string; error: string }[];
  error?: string;
}

/** The latest sync of one app, as kept for the Custom Formats settings page. */
export type StoredTrashSyncResult = Omit<TrashSyncResult, "error"> & {
  app: "radarr" | "sonarr";
  finishedAt: string;
  error: string | null;
};

function lastResultKey(app: "radarr" | "sonarr"): string {
  return `trashSyncLastResult${APP_LABELS[app]}`;
}

function saveLastResult(app: "radarr" | "sonarr", result: TrashSyncResult): void {
  const stored: StoredTrashSyncResult = {
    app,
    finishedAt: new Date().toISOString(),
    added: result.added,
    updated: result.updated,
    unsupported: result.unsupported,
    partiallyUnsupported: result.partiallyUnsupported,
    failed: result.failed,
    error: result.error ?? null,
  };
  setSetting(lastResultKey(app), JSON.stringify(stored));
}

export function getLastTrashSyncResult(app: "radarr" | "sonarr"): StoredTrashSyncResult | null {
  const raw = getSetting(lastResultKey(app));
  if (!raw) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.finishedAt !== "string") return null;
  const list = (value: unknown): any[] => (Array.isArray(value) ? value.filter((v) => v != null) : []);
  return {
    app,
    finishedAt: parsed.finishedAt,
    added: Number(parsed.added) || 0,
    updated: Number(parsed.updated) || 0,
    unsupported: list(parsed.unsupported).map(String),
    partiallyUnsupported: list(parsed.partiallyUnsupported).map((p) => ({
      name: String(p.name ?? ""),
      skipped: list(p.skipped).map(String),
    })),
    failed: list(parsed.failed).map((f) => ({ name: String(f.name ?? ""), error: String(f.error ?? "") })),
    error: typeof parsed.error === "string" && parsed.error ? parsed.error : null,
  };
}

/** Records the outcome for the settings page on every way out — success, the listing failure, or
 * an unexpected throw — so whoever started the sync (the UI polls for a new finishedAt) always
 * sees it finish. */
const syncsInFlight = new Map<"radarr" | "sonarr", Promise<TrashSyncResult>>();

export function isTrashSyncRunning(app: "radarr" | "sonarr"): boolean {
  return syncsInFlight.has(app);
}

/** One sync per app at a time: a second request (another tab, a reload's retry) joins the running one
 * instead of fetching and writing every format again alongside it. */
export function syncTrashFormats(app: "radarr" | "sonarr"): Promise<TrashSyncResult> {
  const running = syncsInFlight.get(app);
  if (running) return running;
  const sync = syncTrashFormatsOnce(app).finally(() => syncsInFlight.delete(app));
  syncsInFlight.set(app, sync);
  return sync;
}

async function syncTrashFormatsOnce(app: "radarr" | "sonarr"): Promise<TrashSyncResult> {
  const result: TrashSyncResult = { added: 0, updated: 0, unsupported: [], partiallyUnsupported: [], failed: [] };
  try {
    return await runTrashSync(app, result);
  } catch (err) {
    result.error = `TRaSH-Guides ${app} sync failed: ${(err as Error).message}`;
    throw err;
  } finally {
    saveLastResult(app, result);
  }
}

async function runTrashSync(app: "radarr" | "sonarr", result: TrashSyncResult): Promise<TrashSyncResult> {
  let files: GithubContentEntry[];
  try {
    files = await listTrashFiles(app);
  } catch (err) {
    result.error = `Failed to list TRaSH-Guides ${app} formats: ${(err as Error).message}`;
    log.warn(`[trashSync] ${result.error}`);
    return result;
  }

  type FetchedFile = { file: GithubContentEntry; trash: TrashCustomFormat | null; error?: string };
  const fetched = await fetchAllWithConcurrency(files, 8, async (file): Promise<FetchedFile> => {
    try {
      const res = await fetch(file.download_url);
      if (!res.ok) return { file, trash: null, error: `download failed: HTTP ${res.status}` };
      return { file, trash: (await res.json()) as TrashCustomFormat };
    } catch (err) {
      return { file, trash: null, error: `download failed: ${(err as Error).message}` };
    }
  });

  const mediaTypes = APP_MEDIA_TYPES[app];

  for (const { file, trash, error } of fetched) {
    if (error) {
      result.failed.push({ name: file.name, error });
      continue;
    }
    if (!trash?.trash_id || !trash.name || !Array.isArray(trash.specifications)) {
      const name = trash && typeof trash.name === "string" && trash.name ? trash.name : file.name;
      result.failed.push({ name, error: "not a valid custom format file" });
      continue;
    }
    try {
      const { groups, skipped } = translateTrashFormat(trash);
      if (groups.length === 0) {
        result.unsupported.push(trash.name);
        continue;
      }
      if (skipped.length > 0) result.partiallyUnsupported.push({ name: trash.name, skipped });

      const existing = (await db.prepare("SELECT id, name FROM custom_formats WHERE trash_id = ?").get(trash.trash_id)) as
        | { id: number; name: string }
        | undefined;
      if (existing) {
        const name = (await pickFormatName(trash.name, app, existing.id)) ?? existing.name;
        await db.prepare("UPDATE custom_formats SET name = ?, patterns = ? WHERE id = ?").run(name, JSON.stringify(groups), existing.id);
        result.updated++;
      } else {
        const name = await pickFormatName(trash.name, app, null);
        if (name == null) {
          result.failed.push({ name: trash.name, error: "a custom format you created already uses this name" });
          continue;
        }
        await db
          .prepare("INSERT INTO custom_formats (name, patterns, media_types, trash_id) VALUES (?, ?, ?, ?)")
          .run(name, JSON.stringify(groups), JSON.stringify(mediaTypes), trash.trash_id);
        result.added++;
      }
    } catch (err) {
      // One malformed file or bad write shouldn't abort the rest of the sync.
      result.failed.push({ name: trash.name, error: (err as Error).message });
    }
  }

  log.info(
    `[trashSync] ${app}: added ${result.added}, updated ${result.updated}, unsupported ${result.unsupported.length}, failed ${result.failed.length}`
  );
  for (const f of result.failed) log.warn(`[trashSync] failed to sync "${f.name}": ${f.error}`);
  for (const p of result.partiallyUnsupported) {
    log.info(`[trashSync] "${p.name}" synced with unsupported condition type(s) skipped: ${p.skipped.join(", ")}`);
  }
  return result;
}
