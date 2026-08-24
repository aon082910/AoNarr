import type { Response } from "express";

/**
 * A minimal Server-Sent-Events broadcast channel for the Activity page's download queue — replaces
 * the page's old fixed 10s poll with a push signal, without needing a WebSocket upgrade or any
 * change to how the app's HTTP server is started (see app.ts/index.ts's createApp() split — SSE is
 * just another Express route, unlike `ws`, which would need `http.createServer`+`WebSocketServer`
 * wired around `app.listen`).
 *
 * Deliberately a "something changed, go re-fetch" signal rather than streaming full row diffs: the
 * queue is mutated from ~9 different call sites across routes/media.ts, routes/search.ts,
 * services/scheduler.ts, services/importer.ts, and routes/activity.ts — broadcasting a lightweight
 * ping and letting the client re-fetch its existing GET /api/activity/queue is far less error-prone
 * than trying to keep a hand-serialized diff in sync with every one of those sites.
 */
const clients = new Set<Response>();

export function registerQueueStreamClient(res: Response): void {
  clients.add(res);
}

export function unregisterQueueStreamClient(res: Response): void {
  clients.delete(res);
}

/** scheduler.ts's download-progress poll loop can call this many times a second across an active
 * queue — coalesced to at most one broadcast per window so a busy queue doesn't turn into a flood
 * of SSE messages (and matching client-side re-fetches) that swamps the browser. */
const MIN_INTERVAL_MS = 1500;
let lastSentAt = 0;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function broadcast(): void {
  lastSentAt = Date.now();
  for (const res of clients) {
    try {
      res.write("event: queue\ndata: {}\n\n");
    } catch {
      // a write to a half-closed connection — the client's own "close" handler will unregister it
    }
  }
}

export function notifyQueueChanged(): void {
  const elapsed = Date.now() - lastSentAt;
  if (elapsed >= MIN_INTERVAL_MS) {
    broadcast();
    return;
  }
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    broadcast();
  }, MIN_INTERVAL_MS - elapsed);
}
