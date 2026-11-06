import { db } from "../../db/index.js";
import type { SearchResult } from "../../types/index.js";
import { limitsFor, type ThrottlearrSettings } from "./settings.js";

/**
 * Throttlearr's hold decision and the bookkeeping around a held grab.
 *
 * A held grab is a queue row with status 'queued' (so every query that counts queued rows still sees its target as
 * covered) and gate_state 'held', no download_id yet, and gate_payload with what the release worker needs to send it
 * later. See the build plan in the vault: "AoNarr Throttlearr Build Plan".
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
export async function ownRowsLoad(clientId: number): Promise<{ active: number }> {
  const row = (await db
    .prepare(
      `SELECT COUNT(*) AS c FROM queue
       WHERE download_client_id = ? AND status IN ('queued', 'downloading')
       AND (gate_state IS NULL OR gate_state IN ('released', 'releasing'))`
    )
    .get(clientId)) as { c: number | string };
  return { active: Number(row.c) };
}

export async function heldCount(clientId: number): Promise<number> {
  const row = (await db.prepare("SELECT COUNT(*) AS c FROM queue WHERE download_client_id = ? AND gate_state = 'held'").get(clientId)) as {
    c: number | string;
  };
  return Number(row.c);
}

export interface HoldInput {
  settings: ThrottlearrSettings;
  client: { id: number; name: string };
  source: string;
  forced: boolean;
  /** Jobs the client holds now (see ownRowsLoad). */
  active: number;
  /** Grabs already held for this client: a new grab never jumps ahead of them. */
  heldAhead: number;
}

export interface HoldVerdict {
  hold: boolean;
  reason?: string;
}

/** Whether the client is limited at all, so a grab to it has to be decided under the client's lock. */
export function clientIsGated(settings: ThrottlearrSettings, clientId: number): boolean {
  if (!settings.enabled) return false;
  return settings.holdAll || limitsFor(settings, clientId).maxActive !== null;
}

/** Pure: should this grab wait at AoNarr? (Count limit only; bytes, schedule and disk come with the release worker.) */
export function evaluateHold(input: HoldInput): HoldVerdict {
  const { settings, client, source, forced, active, heldAhead } = input;
  if (!settings.enabled) return { hold: false };
  // A grab someone chose by hand is wanted now.
  if (settings.bypassManual && (source === "interactive" || forced)) return { hold: false };
  if (settings.holdAll) return { hold: true, reason: "All grabs are being held" };
  const limits = limitsFor(settings, client.id);
  if (limits.maxActive === null) return { hold: false };
  if (active >= limits.maxActive) {
    return { hold: true, reason: `${client.name} has ${active} of ${limits.maxActive} jobs` };
  }
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
