/**
 * "Something the health checks look at has changed." Kept apart from healthReport.ts so the code that causes the
 * change (a backup that failed, a saved setting) can announce it without importing the report, which imports them.
 */
const listeners = new Set<() => void>();

export function onHealthChange(listener: () => void): void {
  listeners.add(listener);
}

export function emitHealthChange(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // a listener must never break the change that announced it
    }
  }
}
