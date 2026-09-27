import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import pdfParse from "pdf-parse";
import { cleanPdfAuthor, cleanPdfTitle } from "./bookFileMetadata.js";
import type { EmbeddedBookMetadata } from "./bookFileMetadata.js";

/**
 * The actual pdf-parse call and Title/Author cleanup for one PDF. Kept as a plain function — rather
 * than inlined in the worker bootstrap below — so a test can call it directly, with pdf-parse mocked
 * in the test's own module registry, without going through a real worker_thread: a worker loads this
 * file into its own separate module registry, which a `vi.mock("pdf-parse")` registered in the main
 * thread never reaches.
 *
 * This is also exactly what runs when this file is loaded as a worker_thread's entry point by
 * runInWorkerWithTimeout (see bookFileMetadata.ts) — the one path a real PDF scan reaches this
 * through in production.
 */
export async function parsePdfInfoTask(filePath: string): Promise<EmbeddedBookMetadata> {
  const data = await pdfParse(fs.readFileSync(filePath), { max: 1 });
  const info = (data?.info ?? {}) as Record<string, unknown>;
  return { title: cleanPdfTitle(info.Title), author: cleanPdfAuthor(info.Author), isbn: null };
}

// True only when Node has loaded this file as a spawned worker thread's entry point (see
// runInWorkerWithTimeout in bookFileMetadata.ts) — not when parsePdfInfoTask above is imported
// directly by a test, nor if some future caller imports it directly in the main thread.
if (parentPort) {
  const port = parentPort;
  const { filePath } = workerData as { filePath: string };
  parsePdfInfoTask(filePath)
    .then((result) => port.postMessage({ ok: true, result }))
    .catch((error: unknown) => port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }));
}
