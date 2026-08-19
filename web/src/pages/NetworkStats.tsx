import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { formatBytes } from "../utils/format.js";

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

/** What AoNarr actually has to report on network activity: each download client's self-reported
 * bandwidth totals (not every client type exposes this), plus a queue status/size breakdown. Not
 * a packet-level capture — AoNarr doesn't proxy the traffic itself. */
export default function NetworkStats() {
  const [data, setData] = useState<NetworkStatsResponse | null>(null);

  useEffect(() => {
    api.get<NetworkStatsResponse>("/system/network-stats").then(setData);
  }, []);

  if (!data) return <p className="empty">Loading...</p>;

  const totalQueued = data.queueByStatus.reduce((sum, q) => sum + q.totalBytes, 0);

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
              <th>Client</th>
              <th>Uploaded</th>
              <th>Downloaded</th>
              <th>Ratio</th>
            </tr>
          </thead>
          <tbody>
            {data.clients.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.name} <span style={{ color: "var(--muted)", fontSize: "0.8rem" }}>({c.type})</span>
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
            <th>Status</th>
            <th>Count</th>
            <th>Size</th>
          </tr>
        </thead>
        <tbody>
          {data.queueByStatus.map((q) => (
            <tr key={q.status}>
              <td>{q.status}</td>
              <td>{q.count}</td>
              <td>{formatBytes(q.totalBytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
