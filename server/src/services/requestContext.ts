import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";

/**
 * Per-request correlation id, propagated via AsyncLocalStorage so every `log.*` call made while
 * handling one request — no matter how deep the call chain (route handler → service → another
 * service) — can be tagged with the same id, without threading a `requestId` parameter through
 * every function signature in the codebase. Read by logger.ts's `push()`; set by the middleware
 * registered in app.ts.
 */
const storage = new AsyncLocalStorage<string>();

export function runWithRequestId<T>(id: string, fn: () => T): T {
  return storage.run(id, fn);
}

export function currentRequestId(): string | undefined {
  return storage.getStore();
}

/** Short (8 hex chars), not a full UUID — this is a log-correlation aid for a single-admin
 * self-hosted app's own log files, not a globally-unique distributed-tracing id. */
export function generateRequestId(): string {
  return crypto.randomBytes(4).toString("hex");
}
