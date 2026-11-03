import { db } from "../db/index.js";
import { log } from "./logger.js";

/**
 * A download client that fails is left alone for a while, longer each time it fails again, as Sonarr's
 * DownloadClientStatusService does (EscalationBackOff: 1 minute up to 24 hours). Before this a dead client was
 * asked again by every 20-second queue poll and by every search pass, each time waiting out the 30-second
 * timeout. The state is kept in download_client_status so a restart does not start the ladder over.
 */
export const CLIENT_BACKOFF_MINUTES = [0, 1, 5, 15, 30, 60, 180, 360, 720, 1440] as const;

interface ClientStatus {
  level: number;
  initialFailureAt: string;
  mostRecentFailureAt: string;
  disabledTill: number | null;
  lastError: string | null;
}

const statuses = new Map<number, ClientStatus>();
/** Writes for one client run one after another (on Postgres two pooled connections could commit them out of order). */
const writeChains = new Map<number, Promise<unknown>>();

/** Whether the client is being left alone right now. */
export function isClientBackedOff(clientId: number, now: number = Date.now()): boolean {
  const until = statuses.get(clientId)?.disabledTill;
  return until != null && until > now;
}

export function clientBackoffUntil(clientId: number): number | null {
  const until = statuses.get(clientId)?.disabledTill;
  return until != null && until > Date.now() ? until : null;
}

export function clientFailureLevel(clientId: number): number {
  return statuses.get(clientId)?.level ?? 0;
}

function persist(clientId: number): void {
  const write = async (): Promise<void> => {
    const status = statuses.get(clientId);
    if (!status) {
      await db.prepare("DELETE FROM download_client_status WHERE client_id = ?").run(clientId);
      return;
    }
    await db
      .prepare(
        `INSERT INTO download_client_status (client_id, escalation_level, initial_failure_at, most_recent_failure_at, disabled_till, last_error)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET escalation_level = excluded.escalation_level, initial_failure_at = excluded.initial_failure_at,
           most_recent_failure_at = excluded.most_recent_failure_at, disabled_till = excluded.disabled_till, last_error = excluded.last_error`
      )
      .run(
        clientId,
        status.level,
        status.initialFailureAt,
        status.mostRecentFailureAt,
        status.disabledTill == null ? null : new Date(status.disabledTill).toISOString(),
        status.lastError
      );
  };
  const next = (writeChains.get(clientId) ?? Promise.resolve())
    .then(write)
    // Best effort: a missing table or a closed database only costs the persistence.
    .catch((err) => log.warn("[clientStatus] could not save a download client's failure state:", (err as Error).message));
  writeChains.set(clientId, next);
  void next.finally(() => {
    if (writeChains.get(clientId) === next) writeChains.delete(clientId);
  });
}

/** Records a failure at the client: the next wait on the ladder starts now. */
export async function recordClientFailure(clientId: number, message: string, now: number = Date.now()): Promise<void> {
  const previous = statuses.get(clientId);
  const at = new Date(now).toISOString();
  // Several grabs queued behind one outage fail together: one outage is one step up the ladder, not one per grab.
  if (previous && previous.disabledTill != null && previous.disabledTill > now) {
    statuses.set(clientId, { ...previous, mostRecentFailureAt: at, lastError: message.slice(0, 500) });
    persist(clientId);
    await writeChains.get(clientId);
    return;
  }
  const level = Math.min((previous?.level ?? 0) + 1, CLIENT_BACKOFF_MINUTES.length - 1);
  statuses.set(clientId, {
    level,
    initialFailureAt: previous?.initialFailureAt ?? at,
    mostRecentFailureAt: at,
    disabledTill: now + CLIENT_BACKOFF_MINUTES[level] * 60_000,
    lastError: message.slice(0, 500),
  });
  if (!previous) log.warn(`[clientStatus] download client ${clientId} failed (${message}); it is left alone for ${CLIENT_BACKOFF_MINUTES[level]} minute(s)`);
  persist(clientId);
  await writeChains.get(clientId);
}

/** The client answered: the ladder starts over. */
export async function recordClientSuccess(clientId: number): Promise<void> {
  if (!statuses.has(clientId)) return;
  statuses.delete(clientId);
  persist(clientId);
  await writeChains.get(clientId);
}

/** Reads the persisted state back. Call once at startup, after the database is up. */
export async function loadClientStatuses(): Promise<void> {
  const rows = (await db.prepare("SELECT * FROM download_client_status").all()) as {
    client_id: number;
    escalation_level: number;
    initial_failure_at: string | null;
    most_recent_failure_at: string | null;
    disabled_till: string | null;
    last_error: string | null;
  }[];
  statuses.clear();
  for (const row of rows) {
    const until = row.disabled_till ? Date.parse(row.disabled_till) : NaN;
    statuses.set(Number(row.client_id), {
      level: Number(row.escalation_level),
      initialFailureAt: row.initial_failure_at ?? new Date().toISOString(),
      mostRecentFailureAt: row.most_recent_failure_at ?? new Date().toISOString(),
      disabledTill: Number.isFinite(until) ? until : null,
      lastError: row.last_error,
    });
  }
}

/** For tests: forget every client's failures (the table is left to the test). */
export function resetClientStatuses(): void {
  statuses.clear();
}
