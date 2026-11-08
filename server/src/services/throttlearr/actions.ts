import { db } from "../../db/index.js";
import { downloadClientFromRow } from "../../db/mappers.js";
import type { DownloadClient } from "../../types/index.js";
import { nowOffsetHoursExpr } from "../../db/asyncDb.js";
import { notifyQueueChanged } from "../realtime.js";
import { listJobs } from "../jobRegistry.js";
import { measureClientState, parsePayload, withClientGate, clientIsGated, limitsActive } from "./gate.js";
import { priorityFor } from "./rules.js";
import { getThrottlearrSettings, limitsFor } from "./settings.js";
import { releaseOne, runAfterGate, type AfterGate, type ReleaseOutcome } from "./release.js";

/**
 * What an admin can do to a grab Throttlearr is holding, and what the Download Clients page and Health say about
 * the gate. The worker (release.ts) does the automatic work; this is the manual side.
 */

/** A held grab's priority "top": above every other grab held for the same client. */
const TOP_BASE = 1000;

export type HeldActionResult = "ok" | "not-held";

/** "Move to top": the grab leaves before every other held grab of its client, whatever their class. */
export async function moveHeldToTop(queueId: number): Promise<HeldActionResult> {
  const row = (await db.prepare("SELECT download_client_id AS client FROM queue WHERE id = ? AND gate_state = 'held'").get(queueId)) as { client: number | null } | undefined;
  if (!row) return "not-held";
  const top = (await db
    .prepare("SELECT COALESCE(MAX(gate_priority), 0) AS p FROM queue WHERE download_client_id = ? AND gate_state = 'held'")
    .get(row.client)) as { p: number | string };
  const next = Math.max(TOP_BASE, Number(top.p) + 1);
  const moved = await db.prepare("UPDATE queue SET gate_priority = ? WHERE id = ? AND gate_state = 'held'").run(next, queueId);
  return moved.changes > 0 ? "ok" : "not-held";
}

/** Back to the priority its class gives it. */
export async function resetHeldPriority(queueId: number): Promise<HeldActionResult> {
  const row = (await db.prepare("SELECT gate_payload FROM queue WHERE id = ? AND gate_state = 'held'").get(queueId)) as { gate_payload: string | null } | undefined;
  if (!row) return "not-held";
  const settings = getThrottlearrSettings();
  const cls = parsePayload(row.gate_payload)?.priorityClass ?? "backlog";
  const moved = await db.prepare("UPDATE queue SET gate_priority = ? WHERE id = ? AND gate_state = 'held'").run(priorityFor(cls, settings.priority), queueId);
  return moved.changes > 0 ? "ok" : "not-held";
}

export type ReleaseNowResult = ReleaseOutcome | "not-held" | "client-off";

/** "Release now": sends the grab at once, whatever the client's limits say. */
export async function releaseHeldNow(queueId: number): Promise<ReleaseNowResult> {
  const row = (await db.prepare("SELECT * FROM queue WHERE id = ? AND gate_state = 'held'").get(queueId)) as any;
  if (!row || row.download_client_id == null) return "not-held";
  const clientRow = await db.prepare("SELECT * FROM download_clients WHERE id = ?").get(row.download_client_id);
  if (!clientRow) return "client-off";
  const client = downloadClientFromRow(clientRow as any) as DownloadClient;
  if (!client.enabled) return "client-off";
  // An admin asked for this one by name: the client's back-off after a recent failure does not stop it. A refused release
  // is searched for again after the lock is free (that search ends in a grab() that takes the same lock).
  const after: AfterGate = [];
  const outcome = await withClientGate(client.id, () => releaseOne(client, row, after, { ignoreBackoff: true }));
  await runAfterGate(after);
  notifyQueueChanged();
  return outcome;
}

// ---- status -----------------------------------------------------------------------------------------------------------

export interface ClientGateStatus {
  id: number;
  name: string;
  type: string;
  limited: boolean;
  held: number;
  oldestHeldAt: string | null;
  /** The client's jobs now, from the client (source "client") or from AoNarr's rows ("own"); null when unreadable. */
  active: number | null;
  bytesLeft: number | null;
  source: "client" | "own" | null;
}

export interface ThrottlearrStatus {
  enabled: boolean;
  dryRun: boolean;
  holdAll: boolean;
  held: number;
  clients: ClientGateStatus[];
  job: { enabled: boolean; running: boolean; lastRunAt: string | null; lastStatus: string | null; lastError: string | null; nextRunAt: string | null } | null;
}

/** The longest the status page waits for one client to say how busy it is. */
const STATUS_PROBE_MS = 4000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export async function throttlearrStatus(): Promise<ThrottlearrStatus> {
  const settings = getThrottlearrSettings();
  const clientRows = (await db.prepare("SELECT * FROM download_clients ORDER BY priority, id").all()) as any[];
  const heldRows = (await db
    .prepare("SELECT download_client_id AS client, COUNT(*) AS c, MIN(gate_held_at) AS oldest FROM queue WHERE gate_state = 'held' AND status = 'queued' GROUP BY download_client_id")
    .all()) as { client: number | null; c: number | string; oldest: string | null }[];
  const heldBy = new Map(heldRows.map((r) => [Number(r.client), r]));

  // Every client is measured at the same time, each given a few seconds: one slow client must not hold up the page.
  const clients: ClientGateStatus[] = await Promise.all(
    clientRows.map(async (row): Promise<ClientGateStatus> => {
      const client = downloadClientFromRow(row) as DownloadClient;
      const held = heldBy.get(client.id);
      const limited = clientIsGated(settings, client.id);
      if (!limited && !held && !limitsActive(limitsFor(settings, client.id))) {
        // A client with nothing to say about the gate still gets a row, so its panel can be opened.
        return { id: client.id, name: client.name, type: client.type, limited: false, held: 0, oldestHeldAt: null, active: null, bytesLeft: null, source: null };
      }
      let active: number | null = null;
      let bytesLeft: number | null = null;
      let source: ClientGateStatus["source"] = null;
      if (client.enabled) {
        try {
          const m = await withTimeout(measureClientState(client, limitsFor(settings, client.id), { strict: false }), STATUS_PROBE_MS);
          active = m.state.active;
          bytesLeft = m.state.bytesLeft;
          source = m.source;
        } catch {
          /* unreadable or too slow: shown as unknown */
        }
      }
      return { id: client.id, name: client.name, type: client.type, limited, held: held ? Number(held.c) : 0, oldestHeldAt: held?.oldest ?? null, active, bytesLeft, source };
    })
  );

  const job = listJobs().find((j) => j.key === "throttlearrRelease");
  return {
    enabled: settings.enabled,
    dryRun: settings.dryRun,
    holdAll: settings.holdAll,
    held: heldRows.reduce((sum, r) => sum + Number(r.c), 0),
    clients,
    job: job ? { enabled: job.enabled, running: job.running, lastRunAt: job.lastRunAt ?? null, lastStatus: job.lastStatus ?? null, lastError: job.lastError ?? null, nextRunAt: job.nextRunAt ?? null } : null,
  };
}

// ---- health -----------------------------------------------------------------------------------------------------------

export interface GateIssue {
  source: string;
  severity: "warning" | "error";
  message: string;
  transient: boolean;
}

/** The release job must have run in this many minutes while grabs are held (it runs every minute). */
const JOB_STALE_MINUTES = 10;

export async function throttlearrIssues(now: Date = new Date()): Promise<GateIssue[]> {
  const settings = getThrottlearrSettings();
  const held = (await db.prepare("SELECT COUNT(*) AS c, MIN(gate_held_at) AS oldest FROM queue WHERE gate_state = 'held' AND status = 'queued'").get()) as { c: number | string; oldest: string | null };
  const count = Number(held.c);
  if (count === 0) return [];
  const issues: GateIssue[] = [];

  const agedHours = Math.max(1, Math.floor(settings.maxHeldAgeHours / 2));
  const aged = Number(
    ((await db.prepare(`SELECT COUNT(*) AS c FROM queue WHERE gate_state = 'held' AND status = 'queued' AND gate_held_at <= ${nowOffsetHoursExpr(db, -agedHours)}`).get()) as { c: number | string }).c
  );
  if (aged > 0) {
    issues.push({
      source: "throttlearr-old-held",
      severity: "warning",
      message: `${aged} grab${aged === 1 ? " has" : "s have"} been held by Throttlearr for more than ${agedHours} hours. ${aged === 1 ? "It is" : "They are"} dropped after ${settings.maxHeldAgeHours} hours and searched for again. Check the limits of its download client, or release ${aged === 1 ? "it" : "them"} from Activity.`,
      transient: false,
    });
  }

  if (settings.enabled && !settings.holdAll) {
    const job = listJobs().find((j) => j.key === "throttlearrRelease");
    const last = job?.lastRunAt ? Date.parse(job.lastRunAt.includes("T") ? job.lastRunAt : `${job.lastRunAt.replace(" ", "T")}Z`) : NaN;
    const stale = !job || !job.enabled || (Number.isFinite(last) ? now.getTime() - last > JOB_STALE_MINUTES * 60_000 : false);
    if (stale) {
      issues.push({
        source: "throttlearr-job",
        severity: "error",
        message: `${count} grab${count === 1 ? " is" : "s are"} held by Throttlearr but its release job ${!job || !job.enabled ? "is switched off" : "has not run for over " + JOB_STALE_MINUTES + " minutes"}. Nothing is sent until it runs again (Settings > Jobs).`,
        transient: true,
      });
    }
  }
  if (settings.enabled && settings.holdAll) {
    issues.push({
      source: "throttlearr-hold-all",
      severity: "warning",
      message: `Throttlearr is set to hold every grab (${count} waiting). Nothing is sent to a download client until "Hold everything" is switched off.`,
      transient: false,
    });
  }
  return issues;
}
