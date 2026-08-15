import { Router } from "express";
import { db } from "../db/client.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import { findRepeatedImports } from "../services/duplicates.js";
import { findUpgradeCandidates } from "../services/upgradeCandidates.js";
import { rootFolderFromRow } from "../db/mappers.js";
import fs from "node:fs";

export const metricsRouter = Router();

function metricLine(name: string, help: string, type: "gauge" | "counter", samples: { labels?: Record<string, string>; value: number }[]): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const s of samples) {
    const labelStr = s.labels
      ? "{" + Object.entries(s.labels).map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`).join(",") + "}"
      : "";
    lines.push(`${name}${labelStr} ${s.value}`);
  }
  return lines.join("\n");
}

/**
 * Prometheus text-exposition metrics — deliberately unauthenticated (same as `/health`) since
 * Prometheus scraping and the admin API key don't mix well, and nothing exposed here is more
 * sensitive than library counts/queue depth; protect this route at the network level if that
 * matters for your deployment.
 */
metricsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const typeCounts = db.prepare("SELECT type, COUNT(*) AS c FROM media_items GROUP BY type").all() as {
      type: string;
      c: number;
    }[];
    const queueByStatus = db.prepare("SELECT status, COUNT(*) AS c FROM queue GROUP BY status").all() as {
      status: string;
      c: number;
    }[];
    const indexerCount = (db.prepare("SELECT COUNT(*) AS c FROM indexers WHERE enabled = 1").get() as { c: number }).c;
    const clientCount = (
      db.prepare("SELECT COUNT(*) AS c FROM download_clients WHERE enabled = 1").get() as { c: number }
    ).c;
    const pendingRequests = (
      db.prepare("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'").get() as { c: number }
    ).c;
    const repeatedImports = findRepeatedImports().length;
    const upgradeCandidates = findUpgradeCandidates().length;

    const folders = (db.prepare("SELECT * FROM root_folders").all() as any[]).map(rootFolderFromRow);
    const diskFree: { labels: Record<string, string>; value: number }[] = [];
    const diskTotal: { labels: Record<string, string>; value: number }[] = [];
    for (const f of folders) {
      try {
        const stat = fs.statfsSync(f.path);
        diskFree.push({ labels: { path: f.path, media_type: f.mediaType }, value: stat.bfree * stat.bsize });
        diskTotal.push({ labels: { path: f.path, media_type: f.mediaType }, value: stat.blocks * stat.bsize });
      } catch {
        // path not reachable — skip this folder's sample rather than emit a bogus 0
      }
    }

    const output = [
      metricLine(
        "aonarr_media_items_total",
        "Media items in the library by type",
        "gauge",
        typeCounts.map((r) => ({ labels: { type: r.type }, value: r.c }))
      ),
      metricLine(
        "aonarr_queue_items",
        "Download queue items by status",
        "gauge",
        queueByStatus.map((r) => ({ labels: { status: r.status }, value: r.c }))
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
