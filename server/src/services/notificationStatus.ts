/**
 * Which notification connections keep failing (Sonarr's NotificationStatusCheck). Kept in memory, per connection
 * id: two Discord channels are reported separately, and a connection that is deleted or switched off is forgotten
 * (notificationConnections.ts), so Health stops naming it.
 */

interface ConnectionFailure {
  /** Failed sends in a row. */
  failures: number;
  since: number;
  /** The latest failed send: a connection nobody sends through any more stops being reported a day after it. */
  last: number;
  lastError: string;
  label: string;
  kind: string;
}

const failing = new Map<number, ConnectionFailure>();
const FAILURE_REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function recordNotificationOutcome(conn: { id: number; kind: string; label: string }, ok: boolean, error?: string): void {
  if (ok) {
    failing.delete(conn.id);
    return;
  }
  const known = failing.get(conn.id);
  // The message can carry the target URL, which can carry a token: only its description (describeTarget) is ever in it.
  failing.set(conn.id, {
    failures: (known?.failures ?? 0) + 1,
    since: known?.since ?? Date.now(),
    last: Date.now(),
    lastError: (error ?? "").slice(0, 300),
    label: conn.label,
    kind: conn.kind,
  });
}

/** A connection was deleted or switched off: whatever it had failed is no longer Health's business. */
export function forgetNotificationFailures(connectionId: number): void {
  failing.delete(connectionId);
}

/** The connections whose last sends all failed (at least `threshold` in a row), for Health. `provider` is the label to show. */
export function failingNotificationProviders(
  threshold = 2
): { connectionId: number; kind: string; provider: string; failures: number; since: string; lastError: string }[] {
  const now = Date.now();
  return Array.from(failing)
    .filter(([, f]) => f.failures >= threshold && now - f.last < FAILURE_REPORT_WINDOW_MS)
    .map(([connectionId, f]) => ({ connectionId, kind: f.kind, provider: f.label, failures: f.failures, since: new Date(f.since).toISOString(), lastError: f.lastError }));
}

/** Test-only: forget the failures. */
export function __resetNotificationFailuresForTests(): void {
  failing.clear();
}
