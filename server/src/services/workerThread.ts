import { Worker, type WorkerOptions } from "node:worker_threads";

export type WorkerOutcome<T> = { ok: true; result: T } | { ok: false; error: string };

/**
 * Runs `workerPath` as a real worker_thread with `workerData`, and forcibly terminates it — an
 * OS-level kill that a synchronous infinite loop cannot resist — if it hasn't posted a `{ok, ...}`
 * response within `timeoutMs`. Used wherever one slow synchronous call (a PDF parse, zipping a
 * database) would otherwise stop the whole event loop: the worker burns its own thread instead.
 * `options` is passed to the Worker (for example `{ eval: true }` when `workerPath` is source text).
 */
export function runInWorkerWithTimeout<T>(
  workerPath: string | URL,
  workerData: unknown,
  timeoutMs: number,
  options: Omit<WorkerOptions, "workerData"> = {}
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(workerPath, { ...options, workerData });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Wait for terminate() itself to settle (it resolves once the worker thread has actually
      // stopped) before rejecting, so a caller never sees "timed out" while the killed worker's
      // busy loop is still tearing down in the background.
      worker.terminate().finally(() => reject(new Error(`timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    timer.unref?.();
    worker.once("message", (message: WorkerOutcome<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().finally(() => (message.ok ? resolve(message.result) : reject(new Error(message.error))));
    });
    worker.once("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`worker exited with code ${code} before responding`));
    });
  });
}
