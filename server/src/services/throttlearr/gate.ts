import { db } from "../../db/index.js";
import { nowOffsetHoursExpr } from "../../db/asyncDb.js";
import { config } from "../../config.js";
import type { DownloadClient, SearchResult } from "../../types/index.js";
import { getDownloadClientAdapter } from "../downloadClient.js";
import { freeBytesAt } from "../freeSpace.js";
import { admit, type Candidate, type ClientState, type PriorityClass } from "./rules.js";
import { limitsFor, type ClientLimits, type ThrottlearrSettings } from "./settings.js";

/**
 * Throttlearr's hold decision and the bookkeeping around a held grab.
 *
 * A held grab is a queue row with status 'queued' (so every query that counts queued rows still sees its target as
 * covered) and gate_state 'held', no download_id yet, and gate_payload with what the release worker needs to send it
 * later. See the build plan in the vault: "AoNarr Throttlearr Build Plan". The rules themselves are in rules.ts.
 */

export type GateState = "held" | "releasing" | "released";

/** SQL for "this row is waiting at AoNarr, not at a download client": the poller, the stalled sweep and the orphan
 * sweep leave such rows alone. `alias` is the queue table's alias, with its dot ("q."), or "". */
export function notWaitingAtGate(alias = ""): string {
  return `COALESCE(${alias}gate_state, '') NOT IN ('held', 'releasing')`;
}

/** What the release worker needs to send a held grab and to write the history `grab()` leaves out at hold time. */
export interface HeldPayload {
  v: 1;
  release: SearchResult;
  /** The client category, resolved at hold time. */
  category: string | null;
  quality: string | null;
  source: string;
  forced: boolean;
  releaseGroup: string | null;
  /** The target the history is written against (a discography has `targetSubItemIds` instead). */
  history: { episodeId: number | null; subItemId: number | null; seasonNumber: number | null };
  targetSubItemIds: number[];
  /** Movie, recent episode or old backlog; decides the priority and whether it waits for the night. */
  priorityClass?: PriorityClass;
}

export function parsePayload(raw: string | null | undefined): HeldPayload | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<HeldPayload> | null;
    if (!p || p.v !== 1 || !p.release || typeof p.release.downloadUrl !== "string" || typeof p.release.title !== "string") return null;
    return p as HeldPayload;
  } catch {
    return null;
  }
}

/** The jobs a download client holds from AoNarr's own point of view: queue rows sent to it and not finished. A row
 * being released counts, because it is about to be there. */
export async function ownRowsLoad(clientId: number): Promise<{ active: number; bytes: number; titleActive: Map<number, number> }> {
  const rows = (await db
    .prepare(
      `SELECT media_item_id AS item, COUNT(*) AS c, SUM(COALESCE(size_left, size, 0)) AS bytes FROM queue
       WHERE download_client_id = ? AND status IN ('queued', 'downloading')
       AND (gate_state IS NULL OR gate_state IN ('released', 'releasing'))
       GROUP BY media_item_id`
    )
    .all(clientId)) as { item: number | string; c: number | string; bytes: number | string | null }[];
  const titleActive = new Map<number, number>();
  let active = 0;
  let bytes = 0;
  for (const r of rows) {
    titleActive.set(Number(r.item), Number(r.c));
    active += Number(r.c);
    bytes += Number(r.bytes ?? 0);
  }
  return { active, bytes, titleActive };
}

export async function heldCount(clientId: number): Promise<number> {
  const row = (await db.prepare("SELECT COUNT(*) AS c FROM queue WHERE download_client_id = ? AND gate_state = 'held'").get(clientId)) as {
    c: number | string;
  };
  return Number(row.c);
}

/** When each add was made, by client, kept in memory: a queue row is deleted once its download is imported, so counting rows
 * alone forgets the adds of a fast client (a cached debrid download imports in minutes) long before the hour is over. */
const addLog = new Map<number, number[]>();
const HOUR_MS = 3_600_000;

/** Notes that a download was just added to the client. */
export function recordAdd(clientId: number, now: number = Date.now()): void {
  const log = (addLog.get(clientId) ?? []).filter((t) => now - t < HOUR_MS);
  log.push(now);
  addLog.set(clientId, log);
}

/** Test-only: forgets the log. */
export function resetAddLog(): void {
  addLog.clear();
}

/**
 * Adds to the client in the last hour: the larger of what this process has sent and the queue rows that have a download id
 * (the rows cover a restart, the log covers the rows that were imported and deleted).
 */
export async function addsLastHour(clientId: number, now: number = Date.now()): Promise<number> {
  const row = (await db
    .prepare(`SELECT COUNT(*) AS c FROM queue WHERE download_client_id = ? AND download_id IS NOT NULL AND added_at >= ${nowOffsetHoursExpr(db, -1)}`)
    .get(clientId)) as { c: number | string };
  const logged = (addLog.get(clientId) ?? []).filter((t) => now - t < HOUR_MS).length;
  return Math.max(Number(row.c), logged);
}

/** Whether a grab from this source skips the hold (a hand-picked or forced release, with the setting on). */
export function bypassesHold(settings: ThrottlearrSettings, source: string, forced: boolean): boolean {
  return settings.enabled && settings.bypassManual && (source === "interactive" || forced);
}

export interface MeasuredState {
  state: ClientState;
  /** Where the job count came from: the client itself, or AoNarr's own queue rows. */
  source: "client" | "own";
}

/**
 * What the client has to do now. The client's own count is best (it includes jobs AoNarr did not add: that is what filled
 * SABnzbd to thousands); a backend without one, or one that does not answer when `strict` is off, is counted from AoNarr's
 * queue rows. With `strict` a client that does not answer throws, and the caller leaves its grabs held.
 */
export async function measureClientState(client: DownloadClient, limits: ClientLimits, opts: { strict: boolean }): Promise<MeasuredState> {
  const own = await ownRowsLoad(client.id);
  let active = own.active;
  let bytesLeft: number | null = own.bytes;
  let source: MeasuredState["source"] = "own";
  const adapter = getDownloadClientAdapter(client.type);
  if (adapter.queueLoad) {
    try {
      const load = await adapter.queueLoad(client);
      active = load.active;
      bytesLeft = load.bytesLeft ?? own.bytes;
      source = "client";
    } catch (err) {
      if (opts.strict) throw err;
    }
  }
  return {
    state: {
      active,
      bytesLeft,
      addsLastHour: limits.addsPerHour !== null ? await addsLastHour(client.id) : 0,
      freeBytes: limits.minFreeBytes !== null ? await freeBytesAt(config.downloadsDir) : null,
      titleActive: own.titleActive,
    },
    source,
  };
}

/** Whether any limit is set for the client. */
export function limitsActive(l: ClientLimits): boolean {
  return l.maxActive !== null || l.maxActiveBytes !== null || l.addsPerHour !== null || l.minFreeBytes !== null || l.windows.length > 0;
}

/** Whether the client is limited at all, so a grab to it has to be decided under the client's lock. */
export function clientIsGated(settings: ThrottlearrSettings, clientId: number): boolean {
  if (!settings.enabled) return false;
  return settings.holdAll || limitsActive(limitsFor(settings, clientId));
}

export interface HoldInput {
  settings: ThrottlearrSettings;
  client: { id: number; name: string };
  source: string;
  forced: boolean;
  /** What the client has to do now (see measureClientState). */
  state: ClientState;
  /** Grabs already held for this client: a new grab never jumps ahead of them. */
  heldAhead: number;
  candidate: Pick<Candidate, "mediaItemId" | "size" | "priorityClass">;
  now: Date;
}

export interface HoldVerdict {
  hold: boolean;
  reason?: string;
}

/** Pure: should this grab wait at AoNarr? */
export function evaluateHold(input: HoldInput): HoldVerdict {
  const { settings, client, source, forced, state, heldAhead, candidate, now } = input;
  if (!settings.enabled) return { hold: false };
  // A grab someone chose by hand is wanted now.
  if (bypassesHold(settings, source, forced)) return { hold: false };
  if (settings.holdAll) return { hold: true, reason: "All grabs are being held" };
  const limits = limitsFor(settings, client.id);
  if (!limitsActive(limits)) return { hold: false };
  const verdict = admit({ clientName: client.name, limits, state, candidate, priority: settings.priority, perTitleLimit: settings.perTitleLimit, now });
  if (!verdict.ok) return { hold: true, reason: verdict.reason };
  // Room now, but grabs are already waiting: they were first.
  if (heldAhead > 0) {
    return { hold: true, reason: `Waiting behind ${heldAhead} held ${heldAhead === 1 ? "grab" : "grabs"}` };
  }
  return { hold: false };
}

/** One lock per client, so two grabs deciding at once cannot both see the same free slot. */
const clientChains = new Map<number, Promise<unknown>>();

export async function withClientGate<T>(clientId: number | null, fn: () => Promise<T>): Promise<T> {
  if (clientId === null) return fn();
  const previous = clientChains.get(clientId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => undefined);
  clientChains.set(clientId, tail);
  try {
    return await run;
  } finally {
    if (clientChains.get(clientId) === tail) clientChains.delete(clientId);
  }
}

/** UTC "YYYY-MM-DD HH:MM:SS", the format the queue's timestamps use. */
export function gateTimestamp(now = new Date()): string {
  return now.toISOString().slice(0, 19).replace("T", " ");
}
