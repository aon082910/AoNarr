import { db } from "../../db/index.js";
import { nowExpr, nowOffsetHoursExpr } from "../../db/asyncDb.js";
import { downloadClientFromRow, mediaItemFromRow, queueItemFromRow } from "../../db/mappers.js";
import type { DownloadClient } from "../../types/index.js";
import { log } from "../logger.js";
import { getDownloadClientAdapter } from "../downloadClient.js";
import { isClientBackedOff, recordClientFailure } from "../clientStatus.js";
import { recordGrabbed } from "../grabHistory.js";
import { notifyGrabbed } from "../notifications.js";
import { notifyQueueChanged } from "../realtime.js";
import { COLLECTION_ITEM_TYPES } from "../bookCollections.js";
import { parseReleaseTitle } from "../releaseParser.js";
import { DownloadClientUnavailableError, ReleaseRefusedError, retryFailedGrab, sendToClient, type GrabSource } from "../scheduler.js";
import { getThrottlearrSettings, limitsFor, type ThrottlearrSettings } from "./settings.js";
import { limitsActive, measureClientState, parsePayload, withClientGate, type HeldPayload } from "./gate.js";
import { selectReleases, type Candidate, type PriorityClass } from "./rules.js";
import { mediaTypeOf, nzbInspectorFor } from "./preflight.js";

/**
 * Throttlearr's release worker: sends held grabs to their download client as the client has room.
 *
 * Runs from the "throttlearrRelease" job every minute and after the queue poll. Per client it measures the
 * client's load (the adapter's own count, or AoNarr's queue rows when the adapter has none), works out how many
 * more jobs the limits allow and sends that many held grabs, best first. Each row is claimed with a
 * compare-and-set (held -> releasing), so a second run, or a restart, can never send one twice.
 */

export interface ReleaseSummary {
  released: number;
  expired: number;
  failed: number;
  /** Clients left alone this run (down, backed off, disabled) with jobs still held. */
  skippedClients: number;
}

let running: Promise<ReleaseSummary> | null = null;

/** Runs one release pass; a pass already running is waited for instead of started twice. `now` is for tests. */
export function releaseHeldGrabs(now: Date = new Date()): Promise<ReleaseSummary> {
  if (!running) running = runRelease(now).finally(() => (running = null));
  return running;
}

/** Never throws: a failed pass is logged and the held grabs wait for the next one. */
export async function releaseHeldGrabsSafely(): Promise<void> {
  try {
    await releaseHeldGrabs();
  } catch (err) {
    log.warn("[throttlearr] release pass failed:", (err as Error).message);
  }
}

/**
 * A row left 'releasing' means the process stopped between claiming it and recording the send. It goes back to
 * 'held'. (If the client had already accepted the add, the retry sends it a second time; qBittorrent drops that
 * duplicate and the tracked-id check below catches the rest.)
 */
export async function resetReleasingRows(): Promise<number> {
  const res = await db.prepare("UPDATE queue SET gate_state = 'held' WHERE gate_state = 'releasing'").run();
  if (res.changes > 0) log.warn(`[throttlearr] ${res.changes} grab(s) were being sent when AoNarr stopped; they are held again`);
  return res.changes;
}

let startupResetDone = false;

async function runRelease(now: Date): Promise<ReleaseSummary> {
  const summary: ReleaseSummary = { released: 0, expired: 0, failed: 0, skippedClients: 0 };
  // The first pass after a start: any row still 'releasing' is left over from the run before.
  if (!startupResetDone) {
    startupResetDone = true;
    await resetReleasingRows();
  }
  const settings = getThrottlearrSettings();

  // A held grab that waited too long is dropped; the search runs again and may find a better release by now.
  summary.expired = await expireOldHeldRows(settings);

  // Held everything on purpose: nothing leaves.
  if (settings.enabled && settings.holdAll) return summary;

  const clientIds = (
    (await db.prepare("SELECT DISTINCT download_client_id AS id FROM queue WHERE gate_state = 'held' AND download_client_id IS NOT NULL").all()) as { id: number | string }[]
  ).map((r) => Number(r.id));

  for (const clientId of clientIds) {
    // What must wait until the client's lock is free (a refused release is searched for again, and that search ends in a
    // grab() that takes the same lock).
    const after: AfterGate = [];
    await withClientGate(clientId, async () => {
      const one = await releaseForClient(clientId, settings, now, after);
      summary.released += one.released;
      summary.failed += one.failed;
      if (one.skipped) summary.skippedClients++;
    });
    await runAfterGate(after);
  }
  if (summary.released > 0 || summary.expired > 0 || summary.failed > 0) notifyQueueChanged();
  return summary;
}

async function expireOldHeldRows(settings: ThrottlearrSettings): Promise<number> {
  if (!settings.enabled) return 0;
  const rows = (await db
    .prepare(`SELECT * FROM queue WHERE gate_state = 'held' AND status = 'queued' AND gate_held_at IS NOT NULL AND gate_held_at <= ${nowOffsetHoursExpr(db, -settings.maxHeldAgeHours)}`)
    .all()) as any[];
  let expired = 0;
  for (const row of rows) {
    const moved = await db
      .prepare(`UPDATE queue SET status = 'failed', gate_state = NULL, updated_at = ${nowExpr(db)} WHERE id = ? AND gate_state = 'held'`)
      .run(row.id);
    if (moved.changes === 0) continue;
    expired++;
    await retryFailedGrab(queueItemFromRow(row) as any, `Held for more than ${settings.maxHeldAgeHours} hours`, { releaseAtFault: false });
    log.info(`[throttlearr] dropped "${row.title}": held for more than ${settings.maxHeldAgeHours} hours`);
  }
  return expired;
}

/** Work to do once the client's lock is released. */
export type AfterGate = Array<() => Promise<void>>;

/** Runs the work left for after the lock; one that fails is logged and the rest still run. */
export async function runAfterGate(after: AfterGate): Promise<void> {
  for (const work of after) {
    try {
      await work();
    } catch (err) {
      log.warn("[throttlearr] could not finish a failed release:", (err as Error).message);
    }
  }
}

async function releaseForClient(clientId: number, settings: ThrottlearrSettings, now: Date, after: AfterGate): Promise<{ released: number; failed: number; skipped: boolean }> {
  const out = { released: 0, failed: 0, skipped: false };
  const clientRow = await db.prepare("SELECT * FROM download_clients WHERE id = ?").get(clientId);
  if (!clientRow) return out; // deleted: its rows were failed with it
  const client = downloadClientFromRow(clientRow as any) as DownloadClient;
  if (!client.enabled || isClientBackedOff(client.id)) {
    out.skipped = true;
    return out;
  }

  const held = (await db
    .prepare("SELECT * FROM queue WHERE download_client_id = ? AND gate_state = 'held' ORDER BY gate_priority DESC, gate_held_at ASC, id ASC")
    .all(client.id)) as any[];
  if (held.length === 0) return out;

  // Throttlearr off, or no limit set for this client: nothing is limited, every held grab goes now.
  const limits = limitsFor(settings, client.id);
  let toSend = held;
  if (settings.enabled && limitsActive(limits)) {
    let measured;
    try {
      measured = await measureClientState(client, limits, { strict: true });
    } catch (err) {
      // The client does not answer: its grabs stay held, and the failure is on file like any other client failure.
      await recordClientFailure(client.id, (err as Error).message).catch(() => undefined);
      out.skipped = true;
      return out;
    }
    const state = measured.state;
    // Rows AoNarr is sending in this very moment may not show in the client's own list yet.
    if (measured.source === "client") {
      state.active += Number(((await db.prepare("SELECT COUNT(*) AS c FROM queue WHERE download_client_id = ? AND gate_state = 'releasing'").get(client.id)) as any).c);
    }
    const candidates: Candidate[] = held.map((r) => ({
      id: Number(r.id),
      mediaItemId: Number(r.media_item_id),
      size: r.size == null ? null : Number(r.size),
      priorityClass: (parsePayload(r.gate_payload)?.priorityClass ?? "backlog") as PriorityClass,
    }));
    const pick = selectReleases(candidates, { clientName: client.name, limits, state, priority: settings.priority, perTitleLimit: settings.perTitleLimit, now });
    const chosen = new Set(pick.selected.map((c) => c.id));
    toSend = held.filter((r) => chosen.has(Number(r.id)));
    // Say why each of the rest is waiting (written only when it changes, so a quiet minute writes nothing).
    for (const [id, reason] of pick.waiting) {
      await db.prepare("UPDATE queue SET gate_reason = ? WHERE id = ? AND gate_state = 'held' AND (gate_reason IS NULL OR gate_reason <> ?)").run(reason, id, reason);
    }
  }

  for (const row of toSend) {
    const result = await releaseOne(client, row, after);
    if (result === "released") out.released++;
    else if (result === "failed") out.failed++;
    else if (result === "client-down") {
      out.skipped = true;
      break;
    }
  }
  return out;
}

export type ReleaseOutcome = "released" | "failed" | "client-down" | "gone";

export async function releaseOne(client: DownloadClient, row: any, after: AfterGate, opts: { ignoreBackoff?: boolean } = {}): Promise<ReleaseOutcome> {
  // Claim the row. Another pass, or a click on "Remove", may have taken it since the list was read.
  const claimed = await db.prepare("UPDATE queue SET gate_state = 'releasing' WHERE id = ? AND gate_state = 'held'").run(row.id);
  if (claimed.changes === 0) return "gone";

  const payload = parsePayload(row.gate_payload);
  if (!payload) {
    await failRow(row, "Throttlearr could not read the held grab", { releaseAtFault: false }, after);
    return "failed";
  }

  let downloadId: string;
  try {
    downloadId = await sendToClient(
      client,
      {
        downloadUrl: payload.release.downloadUrl,
        title: payload.release.title,
        protocol: payload.release.protocol,
        indexerId: payload.release.indexerId,
        category: payload.category,
        ignoreBackoff: opts.ignoreBackoff,
        inspectNzb:
          payload.source === "interactive"
            ? undefined
            : await nzbInspectorFor(getThrottlearrSettings(), payload.release, Number(row.media_item_id), (await mediaTypeOf(Number(row.media_item_id))) ?? "movie"),
      },
      payload.source as GrabSource
    );
  } catch (err) {
    if (err instanceof DownloadClientUnavailableError) {
      // Not the release's fault: it goes back to waiting.
      await db.prepare("UPDATE queue SET gate_state = 'held', gate_reason = ? WHERE id = ? AND gate_state = 'releasing'").run(`${client.name} is unavailable`, row.id);
      await recordClientFailure(client.id, err.message).catch(() => undefined);
      return "client-down";
    }
    const reason = err instanceof ReleaseRefusedError || err instanceof Error ? err.message : String(err);
    // The client refused this release (a dead link, an invalid NZB): blocklist it and search for the next one.
    await failRow(row, reason, { releaseAtFault: true }, after);
    return "failed";
  }

  const best = payload.release;
  try {
    const duplicate = await db
      .prepare("SELECT id FROM queue WHERE download_client_id = ? AND download_id = ? AND status NOT IN ('failed') AND id <> ?")
      .get(client.id, downloadId, row.id);
    if (duplicate) {
      // The client already holds this download for another queue row: this one adds nothing.
      log.info(`[throttlearr] "${row.title}" is already being downloaded by "${client.name}" for another queue entry`);
      await db.prepare("DELETE FROM queue WHERE id = ?").run(row.id);
      return "gone";
    }

    const facts = {
      source: payload.source,
      quality: payload.quality,
      client: { id: client.id, name: client.name },
      forced: payload.forced,
      releaseGroup: payload.releaseGroup,
      downloadId,
      heldForSeconds: heldSeconds(row),
    };
    let stillThere = true;
    await db.transaction(async () => {
      const moved = await db
        .prepare(
          `UPDATE queue SET download_id = ?, gate_state = 'released', gate_reason = NULL, added_at = ${nowExpr(db)}, updated_at = ${nowExpr(db)}, last_progress_at = NULL
           WHERE id = ? AND gate_state = 'releasing'`
        )
        .run(downloadId, row.id);
      // An admin removed the row while the grab was on its way: nothing tracks it now, so no history either.
      if (moved.changes === 0) {
        stillThere = false;
        return;
      }
      if (payload.targetSubItemIds.length > 0) {
        for (const id of payload.targetSubItemIds) await recordGrabbed(row.media_item_id, { episodeId: null, subItemId: id, seasonNumber: null }, best, facts);
      } else {
        await recordGrabbed(row.media_item_id, payload.history, best, facts);
      }
    });
    if (!stillThere) {
      // The client has the download but AoNarr no longer wants it: take it back (files too, nothing was imported).
      try {
        await getDownloadClientAdapter(client.type).removeDownload?.(client, downloadId, true);
      } catch (err) {
        log.warn(`[throttlearr] could not take "${best.title}" back from "${client.name}":`, (err as Error).message);
      }
      log.info(`[throttlearr] "${best.title}" was removed while it was being sent; taken back from "${client.name}"`);
      return "gone";
    }
  } catch (err) {
    // The client has the download but recording it failed (a database error): the row must still lead to it, or it would sit
    // in "releasing" with a download nothing tracks, and be sent a second time after a restart.
    return await trackAfterFailedRecord(client, row, downloadId, best.title, err);
  }

  const mediaRow = (await db.prepare("SELECT * FROM media_items WHERE id = ?").get(row.media_item_id)) as any;
  await notifyReleased(client, row, payload, mediaRow, downloadId);
  log.info(`[throttlearr] released "${best.title}" to "${client.name}"`);
  return "released";
}

/** After a send, writing the result failed: save the least that keeps the download tracked, else take it back and hold the grab. */
async function trackAfterFailedRecord(client: DownloadClient, row: any, downloadId: string, title: string, cause: unknown): Promise<ReleaseOutcome> {
  log.error(`[throttlearr] "${title}" was sent to "${client.name}" but recording it failed:`, (cause as Error).message);
  try {
    await db
      .prepare(`UPDATE queue SET download_id = ?, gate_state = 'released', gate_reason = NULL, added_at = ${nowExpr(db)}, updated_at = ${nowExpr(db)}, last_progress_at = NULL WHERE id = ? AND gate_state = 'releasing'`)
      .run(downloadId, row.id);
    return "released";
  } catch (err) {
    log.error(`[throttlearr] could not track "${title}" either; taking it back from "${client.name}":`, (err as Error).message);
    try {
      await getDownloadClientAdapter(client.type).removeDownload?.(client, downloadId, true);
    } catch {
      /* the next pass sends it again; the client drops a duplicate add */
    }
    await db.prepare("UPDATE queue SET gate_state = 'held', gate_reason = ? WHERE id = ? AND gate_state = 'releasing'").run("Could not be recorded; waiting to be sent again", row.id).catch(() => undefined);
    return "client-down";
  }
}

/** How long the row waited at the gate, in seconds (the hold time is stored as a UTC "YYYY-MM-DD HH:MM:SS" text). */
function heldSeconds(row: any, now: Date = new Date()): number | null {
  if (!row.gate_held_at) return null;
  const since = Date.parse(`${String(row.gate_held_at).replace(" ", "T").replace(/Z?$/, "Z")}`);
  return Number.isFinite(since) ? Math.max(0, (now.getTime() - since) / 1000) : null;
}

async function failRow(row: any, reason: string, opts: { releaseAtFault: boolean }, after: AfterGate): Promise<void> {
  await db.prepare(`UPDATE queue SET status = 'failed', gate_state = NULL, updated_at = ${nowExpr(db)} WHERE id = ?`).run(row.id);
  // The blocklist entry and the search for another release come after the lock is released: that search ends in grab(),
  // which waits for this same lock.
  after.push(() => retryFailedGrab(queueItemFromRow({ ...row, status: "failed", gate_state: null }) as any, reason, opts));
}

async function notifyReleased(client: DownloadClient, row: any, payload: HeldPayload, mediaRow: any, downloadId: string): Promise<void> {
  if (!mediaRow) return;
  const item = mediaItemFromRow(mediaRow);
  const best = payload.release;
  const targets = payload.targetSubItemIds;
  const context = {
    mediaItemId: item.id,
    episodeIds: row.episode_id ? [Number(row.episode_id)] : undefined,
    release: {
      title: best.title,
      indexer: best.indexerName,
      size: row.size ?? null,
      quality: payload.quality,
      releaseGroup: payload.releaseGroup ?? parseReleaseTitle(best.title).releaseGroup,
      protocol: best.protocol,
    },
    downloadClient: { name: client.name, type: client.type, downloadId },
  };
  const group = COLLECTION_ITEM_TYPES.has(item.type) ? { label: "Collection", noun: "book" } : { label: "Discography", noun: "album" };
  const title = targets.length > 0 ? `${item.title} - ${group.label}: ${targets.length} ${group.noun}${targets.length === 1 ? "" : "s"}` : item.title;
  try {
    await notifyGrabbed(title, best.title, context);
  } catch (err) {
    log.warn("[throttlearr] notification failed:", (err as Error).message);
  }
}
