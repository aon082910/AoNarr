// Records what a page does while a test runs: console errors, uncaught exceptions, failed and 4xx/5xx
// requests, every /api call, and in-flight requests (so "settled" can mean "no API call pending").
import type { Page, Request } from "@playwright/test";
import { APP_ORIGIN } from "../../config/shared";
import type { Finding } from "./allowlist";

export interface ApiCall {
  method: string;
  path: string;
  status: number;
}

const BLOCKED_BY_GUARD = "net::ERR_BLOCKED_BY_CLIENT";

/** /api/media/12 -> /api/media/:id ; used so the call list is comparable between runs and designs. */
export function normalizeApiPath(p: string): string {
  return p
    .replace(/\/[0-9a-f]{32,}(?=\/|$|\?)/gi, "/:token")
    .replace(/\/\d+(?=\/|$|\?)/g, "/:id")
    .replace(/\d{4}-\d{2}-\d{2}/g, ":date");
}

export class Collector {
  readonly consoleErrors: Finding[] = [];
  readonly pageErrors: Finding[] = [];
  readonly failedRequests: Finding[] = [];
  readonly badResponses: Finding[] = [];
  readonly external: Finding[] = [];
  readonly warnings: string[] = [];
  readonly apiCalls: ApiCall[] = [];
  private readonly pending = new Set<Request>();
  private lastActivity = Date.now();

  constructor(private readonly page: Page, private readonly origin: string = APP_ORIGIN) {
    page.on("console", (m) => {
      // The browser logs a console error for every request the GET-only guard aborts; the guard reports (and fails on) those itself.
      if (m.type() === "error" && m.text().includes(BLOCKED_BY_GUARD)) return;
      if (m.type() === "error") this.consoleErrors.push({ kind: "console", text: m.text(), path: pathOf(m.location().url, origin) });
      else if (m.type() === "warning" && this.warnings.length < 50) this.warnings.push(m.text().slice(0, 300));
    });
    page.on("pageerror", (e) => this.pageErrors.push({ kind: "pageerror", text: String(e.stack ?? e.message ?? e).slice(0, 600) }));
    // A new document discards the old one's requests without always reporting them as finished or failed.
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) this.pending.clear();
    });
    page.on("request", (r) => {
      this.lastActivity = Date.now();
      const u = safeUrl(r.url());
      if (!u) return;
      if (u.origin !== origin) {
        if (u.protocol === "http:" || u.protocol === "https:") this.external.push({ kind: "external", text: `${r.method()} ${u.origin}${u.pathname}`, path: u.origin + u.pathname });
        return;
      }
      this.pending.add(r);
    });
    page.on("response", (res) => {
      this.lastActivity = Date.now();
      const req = res.request();
      const u = safeUrl(res.url());
      if (!u || u.origin !== origin) return;
      // Long-lived streams (SSE) never finish: stop counting them as in flight once their headers arrive.
      if ((res.headers()["content-type"] ?? "").includes("text/event-stream")) this.pending.delete(req);
      const p = u.pathname + u.search;
      if (u.pathname.startsWith("/api/")) this.apiCalls.push({ method: req.method(), path: normalizeApiPath(p), status: res.status() });
      if (res.status() >= 400) this.badResponses.push({ kind: "http", text: `${req.method()} ${p} -> ${res.status()}`, path: p, status: res.status(), method: req.method() });
    });
    page.on("requestfinished", (r) => {
      this.lastActivity = Date.now();
      this.pending.delete(r);
    });
    page.on("requestfailed", (r) => {
      this.lastActivity = Date.now();
      this.pending.delete(r);
      const err = r.failure()?.errorText ?? "failed";
      if (err.startsWith(BLOCKED_BY_GUARD)) return; // the GET-only guard reports these itself
      const u = safeUrl(r.url());
      if (!u || u.origin !== origin) return;
      this.failedRequests.push({ kind: "requestfailed", text: `${r.method()} ${u.pathname}${u.search} (${err})`, path: u.pathname + u.search, method: r.method() });
    });
  }

  get inFlight(): number {
    return this.pending.size;
  }

  /** "GET /api/x" for every request still in flight (shown in settle errors). */
  describePending(): string[] {
    return [...this.pending].map((r) => {
      const u = safeUrl(r.url());
      return `${r.method()} ${u ? u.pathname + u.search : r.url()}`;
    });
  }

  /** Resolves true once no tracked request has been pending for `quietMs`; false on timeout. */
  async waitNetworkQuiet(quietMs = 500, timeoutMs = 15000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.pending.size === 0 && Date.now() - this.lastActivity >= quietMs) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  /** Forget everything seen so far (used between phases of one test). */
  reset(): void {
    this.consoleErrors.length = 0;
    this.pageErrors.length = 0;
    this.failedRequests.length = 0;
    this.badResponses.length = 0;
    this.external.length = 0;
    this.warnings.length = 0;
    this.apiCalls.length = 0;
  }

  /** All findings the smoke judge looks at. */
  findings(): Finding[] {
    return [...this.consoleErrors, ...this.pageErrors, ...this.failedRequests, ...this.badResponses, ...this.external];
  }

  /** De-duplicated "METHOD /api/path -> status" list. */
  apiCallSummary(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const c of this.apiCalls) {
      const key = `${c.method} ${c.path}`;
      (out[key] ??= []);
      if (!out[key].includes(c.status)) out[key].push(c.status);
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
  }
}

function safeUrl(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

function pathOf(url: string, origin: string): string | undefined {
  const u = safeUrl(url);
  if (!u) return undefined;
  return u.origin === origin ? u.pathname + u.search : u.origin + u.pathname;
}
