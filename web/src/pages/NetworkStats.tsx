import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { formatBytes } from "../utils/format.js";
import { useSortableTable } from "../hooks/useSortableTable.js";

interface ClientStat {
  id: number;
  name: string;
  type: string;
  available: boolean;
  error?: string;
  uploadedTotalBytes?: number;
  downloadedTotalBytes?: number;
  globalRatio?: number | null;
}

interface QueueStat {
  status: string;
  count: number;
  totalBytes: number;
}

interface NetworkStatsResponse {
  clients: ClientStat[];
  queueByStatus: QueueStat[];
}

const TYPE_LABELS: Record<string, string> = {
  qbittorrent: "qBittorrent",
  sabnzbd: "SABnzbd",
  http: "Direct HTTP download",
  ytdlp: "yt-dlp",
  realdebrid: "Real-Debrid",
  alldebrid: "AllDebrid",
  torbox: "TorBox",
  blackhole: "Blackhole (watch folder)",
  slskd: "Soulseek (via slskd)",
};

const QUEUE_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  downloading: "Downloading",
  importing: "Importing",
  completed: "Completed",
  imported: "Imported",
  failed: "Failed",
};

/** What AoNarr actually has to report on network activity: each download client's self-reported
 * bandwidth totals (not every client type exposes this), plus a queue status/size breakdown. Not
 * a packet-level capture — AoNarr doesn't proxy the traffic itself. */
export default function NetworkStats() {
  const [data, setData] = useState<NetworkStatsResponse | null>(null);
  const clientSort = useSortableTable<ClientStat, "client" | "uploaded" | "downloaded" | "ratio">("client");
  const queueSort = useSortableTable<QueueStat, "status" | "count" | "size">("status");

  useEffect(() => {
    api.get<NetworkStatsResponse>("/system/network-stats").then(setData);
  }, []);

  if (!data) return <p className="empty">Loading...</p>;

  const totalQueued = data.queueByStatus.reduce((sum, q) => sum + q.totalBytes, 0);

  const sortedClients = clientSort.sortRows(data.clients, (a, b, key) => {
    if (key === "client") return a.name.localeCompare(b.name);
    if (key === "uploaded") return (a.uploadedTotalBytes ?? 0) - (b.uploadedTotalBytes ?? 0);
    if (key === "downloaded") return (a.downloadedTotalBytes ?? 0) - (b.downloadedTotalBytes ?? 0);
    return (a.globalRatio ?? 0) - (b.globalRatio ?? 0);
  });
  const sortedQueue = queueSort.sortRows(data.queueByStatus, (a, b, key) => {
    if (key === "status") return a.status.localeCompare(b.status);
    if (key === "count") return a.count - b.count;
    return a.totalBytes - b.totalBytes;
  });

  return (
    <div>
      <h1>Network Stats</h1>
      <p style={{ color: "var(--muted)" }}>
        Self-reported by each download client and AoNarr's own queue — not a packet-level network
        capture.
      </p>

      <h2>Download Clients</h2>
      {data.clients.length === 0 && <p className="empty">No enabled download clients.</p>}
      {data.clients.length > 0 && (
        <table>
          <thead>
            <tr>
              {clientSort.sortableHeader("client", "Client")}
              {clientSort.sortableHeader("uploaded", "Uploaded")}
              {clientSort.sortableHeader("downloaded", "Downloaded")}
              {clientSort.sortableHeader("ratio", "Ratio")}
            </tr>
          </thead>
          <tbody>
            {sortedClients.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.name} <span style={{ color: "var(--muted)", fontSize: "0.8rem" }}>({TYPE_LABELS[c.type] ?? c.type})</span>
                </td>
                {c.available ? (
                  <>
                    <td>{formatBytes(c.uploadedTotalBytes ?? 0)}</td>
                    <td>{formatBytes(c.downloadedTotalBytes ?? 0)}</td>
                    <td>{c.globalRatio != null ? c.globalRatio.toFixed(2) : "-"}</td>
                  </>
                ) : (
                  <td colSpan={3} style={{ color: "var(--muted)" }}>
                    {c.error ?? "Bandwidth stats not available for this client type"}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Queue</h2>
      <p style={{ color: "var(--muted)" }}>{formatBytes(totalQueued)} total across all queue items</p>
      <table>
        <thead>
          <tr>
            {queueSort.sortableHeader("status", "Status")}
            {queueSort.sortableHeader("count", "Count")}
            {queueSort.sortableHeader("size", "Size")}
          </tr>
        </thead>
        <tbody>
          {sortedQueue.map((q) => (
            <tr key={q.status}>
              <td>{QUEUE_STATUS_LABELS[q.status] ?? q.status}</td>
              <td>{q.count}</td>
              <td>{formatBytes(q.totalBytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
