import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client.js";
import { useSortableTable } from "../hooks/useSortableTable.js";
import type { BlocklistEntry } from "../types.js";

/** Radarr/Sonarr-style Blocklist page — every release AoNarr has been told never to grab again
 * (via the "Blocklist" button on a search result, or an automatic retry-after-failure), with a
 * per-entry or bulk "remove" to let something back in. */
export default function Blocklist() {
  const [entries, setEntries] = useState<BlocklistEntry[] | null>(null);

  function load() {
    api.get<BlocklistEntry[]>("/blocklist").then(setEntries);
  }

  useEffect(load, []);

  async function remove(id: number) {
    await api.del(`/blocklist/${id}`);
    setEntries((prev) => prev?.filter((e) => e.id !== id) ?? null);
  }

  async function clearAll() {
    if (!entries || entries.length === 0) return;
    if (!confirm(`Remove all ${entries.length} blocklist entries? This lets every one of them be grabbed again.`)) return;
    await api.del("/blocklist");
    setEntries([]);
  }

  const { sortRows, sortableHeader } = useSortableTable<BlocklistEntry, "media" | "release" | "reason" | "date">("date", "desc");
  const sorted = entries
    ? sortRows(entries, (a, b, key) => {
        if (key === "media") return a.mediaTitle.localeCompare(b.mediaTitle);
        if (key === "release") return a.releaseTitle.localeCompare(b.releaseTitle);
        if (key === "reason") return (a.reason ?? "").localeCompare(b.reason ?? "");
        return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
      })
    : [];

  if (!entries) return <p className="empty">Loading...</p>;

  return (
    <div>
      <h1>Blocklist</h1>
      <p style={{ color: "var(--muted)" }}>
        Releases AoNarr won't grab again — added manually from a search result, or automatically
        after a grab fails to import. Remove an entry to let it be considered again.
      </p>
      {entries.length > 0 && (
        <p>
          <button className="secondary" onClick={clearAll}>
            Clear all
          </button>
        </p>
      )}
      {entries.length === 0 && <p className="empty">Nothing blocklisted.</p>}
      {entries.length > 0 && (
        <table>
          <thead>
            <tr>
              {sortableHeader("media", "Media")}
              {sortableHeader("release", "Release")}
              {sortableHeader("reason", "Reason")}
              {sortableHeader("date", "Date")}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((e) => (
              <tr key={e.id}>
                <td>
                  <Link to={`/media/${e.mediaItemId}`}>{e.mediaTitle}</Link>
                </td>
                <td style={{ wordBreak: "break-all" }}>{e.releaseTitle}</td>
                <td>{e.reason ?? "—"}</td>
                <td>{new Date(e.createdAt).toLocaleString()}</td>
                <td>
                  <button className="secondary" onClick={() => remove(e.id)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
