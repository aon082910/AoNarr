import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import type { RecycleBinEntry } from "../types.js";
import { formatBytes } from "../utils/format.js";

/** Grouped by library type so browsing it mirrors the actual library folder structure — same
 * grouping the server's recycle_bin.media_type + physical recycle-bin/{type}/ layout use. */
export default function RecycleBin() {
  const mediaTypes = useMediaTypes();
  const [entries, setEntries] = useState<RecycleBinEntry[]>([]);
  const [openType, setOpenType] = useState<string | null>(null);

  function load() {
    api.get<RecycleBinEntry[]>("/recycle-bin").then(setEntries);
  }
  useEffect(load, []);

  async function restore(id: number) {
    await api.post(`/recycle-bin/${id}/restore`, {});
    load();
  }

  async function purge(id: number, title: string) {
    if (!confirm(`Permanently delete "${title}"? This cannot be undone.`)) return;
    await api.del(`/recycle-bin/${id}`);
    load();
  }

  const byType = entries.reduce<Record<string, RecycleBinEntry[]>>((acc, e) => {
    (acc[e.mediaType] ??= []).push(e);
    return acc;
  }, {});

  return (
    <div>
      <h1>Recycle Bin</h1>
      <p style={{ color: "var(--muted)" }}>
        Files removed with "delete files" (from Media Detail, or by watch-status auto-archival's
        permanent-delete option) land here instead of being deleted outright — restore them, or
        let the scheduled cleanup job (see Jobs) purge them after the configured retention period.
        Configure retention and the recycle bin's own location in Settings.
      </p>
      {entries.length === 0 && <p className="empty">Recycle bin is empty.</p>}
      {Object.entries(byType).map(([type, items]) => {
        const label = mediaTypes.find((t) => t.key === type)?.label ?? type;
        const isOpen = openType === type;
        return (
          <div key={type} style={{ marginBottom: 12 }}>
            <h2 style={{ cursor: "pointer" }} onClick={() => setOpenType(isOpen ? null : type)}>
              {isOpen ? "▾" : "▸"} {label} ({items.length})
            </h2>
            {isOpen && (
              <table>
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Original path</th>
                    <th>Size</th>
                    <th>Deleted</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((e) => (
                    <tr key={e.id}>
                      <td>{e.title}</td>
                      <td style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {e.originalPath}
                      </td>
                      <td>{formatBytes(e.sizeBytes)}</td>
                      <td>{new Date(e.deletedAt).toLocaleString()}</td>
                      <td style={{ display: "flex", gap: 6 }}>
                        <button className="secondary" onClick={() => restore(e.id)}>
                          Restore
                        </button>
                        <button className="danger" onClick={() => purge(e.id, e.title)}>
                          Delete forever
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}
