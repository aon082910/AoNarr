import { Router } from "express";
import { db } from "../db/index.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { findRepeatedImports } from "../services/duplicates.js";
import { findUpgradeCandidates } from "../services/upgradeCandidates.js";
import { rootFolderFromRow } from "../db/mappers.js";
import { getHttpMetricsSamples } from "../services/httpMetrics.js";
import { statfsAsync } from "../services/fsAsync.js";
import { getSetting } from "../services/settingsStore.js";
import { safeEqual } from "../middleware/auth.js";

/** A scrape or status page must not wait out a dead mount. */
const METRICS_STATFS_TIMEOUT_MS = 5000;

export const metricsRouter = Router();

type Sample = { labels?: Record<string, string>; value: number };

/** Exposition-format label escaping — a root folder's free-text name can contain a backslash or
 * newline, and an unescaped newline ends the sample line mid-label, so Prometheus rejects the
 * whole scrape. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function metricLine(name: string, help: string, type: "gauge" | "counter", samples: Sample[]): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const s of samples) {
    const labelStr = s.labels
      ? "{" + Object.entries(s.labels).map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",") + "}"
      : "";
    lines.push(`${name}${labelStr} ${s.value}`);
  }
  return lines.join("\n");
}

interface ExpensiveGauges {
  repeatedImports: number;
  upgradeCandidates: number;
  diskFree: Sample[];
  diskTotal: Sample[];
}

// The route is unauthenticated, and these gauges walk the whole import history, every monitored
// item/episode and statfs each root folder — recomputing them per hit let any client that loops
// the request keep the server busy. Concurrent scrapes share one in-flight computation.
const EXPENSIVE_GAUGES_TTL_MS = 5 * 60 * 1000;
let expensiveCache: { at: number; gauges: ExpensiveGauges } | null = null;
let expensiveInFlight: Promise<ExpensiveGauges> | null = null;

async function computeExpensiveGauges(): Promise<ExpensiveGauges> {
  const repeatedImports = (await findRepeatedImports()).length;
  const upgradeCandidates = (await findUpgradeCandidates()).length;

  const folders = ((await db.prepare("SELECT * FROM root_folders").all()) as any[]).map(rootFolderFromRow);
  const diskFree: Sample[] = [];
  const diskTotal: Sample[] = [];
  for (const f of folders) {
    // statfsAsync: a dead mount costs this folder's sample, not the whole process (see fsAsync.ts).
    const stat = await statfsAsync(f.path, METRICS_STATFS_TIMEOUT_MS).catch(() => null);
    if (!stat) continue; // path not reachable — skip this folder's sample rather than emit a bogus 0
    // Identified by id/name, never the host path: the path would tell an anonymous caller how
    // the server's storage is laid out.
    const labels: Record<string, string> = { root_folder_id: String(f.id), media_type: f.mediaType };
    if (f.name) labels.name = f.name;
    diskFree.push({ labels, value: stat.bavail * stat.bsize });
    diskTotal.push({ labels, value: stat.blocks * stat.bsize });
  }
  return { repeatedImports, upgradeCandidates, diskFree, diskTotal };
}

function getExpensiveGauges(): Promise<ExpensiveGauges> {
  if (expensiveCache && Date.now() - expensiveCache.at < EXPENSIVE_GAUGES_TTL_MS) {
    return Promise.resolve(expensiveCache.gauges);
  }
  expensiveInFlight ??= computeExpensiveGauges()
    .then((gauges) => {
      expensiveCache = { at: Date.now(), gauges };
      return gauges;
    })
    .finally(() => {
      expensiveInFlight = null;
    });
  return expensiveInFlight;
}

/**
 * Prometheus text-exposition metrics — deliberately unauthenticated (same as `/health`) since
 * Prometheus scraping and the admin API key don't mix well. It exposes library counts, queue depth
 * and per-root-folder disk space (by root folder id/name, not path); protect this route at the
 * network level if even that matters for your deployment. The history/library-wide gauges and disk
 * samples are refreshed at most every few minutes.
 */
metricsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    // With a metrics token set, the page needs it (as `Authorization: Bearer <token>` or `?token=`) or the instance API key.
    const required = getSetting("metricsToken");
    if (required) {
      const bearer = /^Bearer (.+)$/i.exec(req.header("Authorization") ?? "")?.[1] ?? (typeof req.query.token === "string" ? req.query.token : "");
      const apiKey = getSetting("apiKey");
      const given = req.header("X-Api-Key") ?? "";
      const ok = (bearer && safeEqual(bearer, required)) || (apiKey && given && safeEqual(given, apiKey));
      if (!ok) {
        res.status(401).json({ error: "This instance requires a metrics token" });
        return;
      }
    }
    const typeCounts = (await db.prepare("SELECT type, COUNT(*) AS c FROM media_items GROUP BY type").all()) as {
      type: string;
      c: number;
    }[];
    const queueByStatus = (await db.prepare("SELECT status, COUNT(*) AS c FROM queue GROUP BY status").all()) as {
      status: string;
      c: number;
    }[];
    const indexerCount = Number(
      ((await db.prepare("SELECT COUNT(*) AS c FROM indexers WHERE enabled = 1").get()) as { c: number }).c
    );
    const clientCount = Number(
      ((await db.prepare("SELECT COUNT(*) AS c FROM download_clients WHERE enabled = 1").get()) as { c: number }).c
    );
    const pendingRequests = Number(
      ((await db.prepare("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'").get()) as { c: number }).c
    );
    const { repeatedImports, upgradeCandidates, diskFree, diskTotal } = await getExpensiveGauges();

    const httpSamples = getHttpMetricsSamples();

    const output = [
      metricLine(
        "aonarr_http_requests_total",
        "Total HTTP requests handled, by method and route",
        "counter",
        httpSamples.map((s) => ({ labels: { method: s.method, route: s.route }, value: s.count }))
      ),
      metricLine(
        "aonarr_http_request_errors_total",
        "HTTP requests that resulted in a 5xx response, by method and route",
        "counter",
        httpSamples.map((s) => ({ labels: { method: s.method, route: s.route }, value: s.errorCount }))
      ),
      metricLine(
        "aonarr_http_request_duration_ms_avg",
        "Average request duration in milliseconds, by method and route (since process start)",
        "gauge",
        httpSamples.map((s) => ({ labels: { method: s.method, route: s.route }, value: s.avgDurationMs }))
      ),
      metricLine(
        "aonarr_media_items_total",
        "Media items in the library by type",
        "gauge",
        typeCounts.map((r) => ({ labels: { type: r.type }, value: Number(r.c) }))
      ),
      metricLine(
        "aonarr_queue_items",
        "Download queue items by status",
        "gauge",
        queueByStatus.map((r) => ({ labels: { status: r.status }, value: Number(r.c) }))
      ),
      metricLine("aonarr_indexers_enabled", "Enabled indexers", "gauge", [{ value: indexerCount }]),
      metricLine("aonarr_download_clients_enabled", "Enabled download clients", "gauge", [{ value: clientCount }]),
      metricLine("aonarr_pending_requests", "Pending household requests", "gauge", [{ value: pendingRequests }]),
      metricLine("aonarr_repeated_imports", "Items imported more than once", "gauge", [{ value: repeatedImports }]),
      metricLine("aonarr_upgrade_candidates", "Items below their profile's current cutoff", "gauge", [
        { value: upgradeCandidates },
      ]),
      metricLine("aonarr_disk_free_bytes", "Free bytes per root folder", "gauge", diskFree),
      metricLine("aonarr_disk_total_bytes", "Total bytes per root folder", "gauge", diskTotal),
    ].join("\n\n");

    res.set("Content-Type", "text/plain; version=0.0.4");
    res.send(output + "\n");
  })
);
