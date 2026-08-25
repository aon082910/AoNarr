import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import type { CorruptMediaReviewEntry, RecycleBinEntry } from "../types.js";
import { formatBytes } from "../utils/format.js";

/** Grouped by library type so browsing it mirrors the actual library folder structure — same
 * grouping the server's recycle_bin.media_type + physical recycle-bin/{type}/ layout use. */
export default function RecycleBin() {
  const mediaTypes = useMediaTypes();
  const [entries, setEntries] = useState<RecycleBinEntry[]>([]);
  const [openType, setOpenType] = useState<string | null>(null);
  const [reviewItems, setReviewItems] = useState<CorruptMediaReviewEntry[]>([]);

  function load() {
    api.get<RecycleBinEntry[]>("/recycle-bin").then(setEntries);
    api.get<CorruptMediaReviewEntry[]>("/corrupt-media-review").then(setReviewItems);
  }
  useEffect(load, []);

  async function recycleReviewItem(id: number, title: string) {
    if (!confirm(`Move "${title}" to the recycle bin and mark it missing?`)) return;
    await api.post(`/corrupt-media-review/${id}/recycle`, {});
    load();
  }

  async function dismissReviewItem(id: number) {
    await api.post(`/corrupt-media-review/${id}/dismiss`, {});
    load();
  }

  // Restoring happens in the background on the server now (large files can take a while to move),
  // so this page polls while anything is mid-restore to notice when it finishes or fails, instead
  // of the old behavior of blocking the request until the move completed.
  useEffect(() => {
    if (!entries.some((e) => e.restoring)) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [entries]);

  async function restore(id: number) {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, restoring: true, restoreError: null } : e)));
    try {
      await api.post(`/recycle-bin/${id}/restore`, {});
    } catch (err) {
      setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, restoring: false, restoreError: (err as Error).message } : e)));
      return;
    }
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
      {reviewItems.length > 0 && (
        <>
          <h2>Pending Corrupt Media Review ({reviewItems.length})</h2>
          <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
            The corrupt-media check flagged these but "review before recycling" is on in Settings,
            so nothing's happened to them yet — the item still shows as present in your library
            until you decide. Recycle the ones that really are bad; dismiss anything that looks
            like a false positive (a network hiccup, a file that was still being written, etc.).
          </p>
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Reason</th>
                <th>File path</th>
                <th>Detected</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {reviewItems.map((r) => (
                <tr key={r.id}>
                  <td>{r.title}</td>
                  <td>{r.reason}</td>
                  <td style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.filePath}</td>
                  <td>{new Date(r.detectedAt).toLocaleString()}</td>
                  <td style={{ display: "flex", gap: 6 }}>
                    <button className="danger" onClick={() => recycleReviewItem(r.id, r.title)}>
                      Recycle
                    </button>
                    <button className="secondary" onClick={() => dismissReviewItem(r.id)}>
                      Dismiss
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2 style={{ marginTop: 24 }}>Recycled Files</h2>
        </>
      )}

      {entries.length === 0 && <p className="empty">Recycle bin is empty.</p>}
      {Object.entries(byType).map(([type, items]) => {
        const label = mediaTypes.find((t) => t.key === type)?.label ?? type;
        const isOpen = openType === type;
        return (
          <div key={type} style={{ marginBottom: 12 }}>
            <h2>
              <button
                type="button"
                onClick={() => setOpenType(isOpen ? null : type)}
                aria-expanded={isOpen}
                style={{ background: "transparent", border: "none", padding: 0, margin: 0, color: "inherit", font: "inherit", cursor: "pointer" }}
              >
                {isOpen ? "▾" : "▸"} {label} ({items.length})
              </button>
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
                      <td>
                        {e.title}
                        {e.restoreError && (
                          <div style={{ color: "var(--danger)", fontSize: "0.8rem" }}>Restore failed: {e.restoreError}</div>
                        )}
                      </td>
                      <td style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {e.originalPath}
                      </td>
                      <td>{formatBytes(e.sizeBytes)}</td>
                      <td>{new Date(e.deletedAt).toLocaleString()}</td>
                      <td style={{ display: "flex", gap: 6 }}>
                        <button className="secondary" onClick={() => restore(e.id)} disabled={e.restoring}>
                          {e.restoring ? "Restoring..." : e.restoreError ? "Retry restore" : "Restore"}
                        </button>
                        <button className="danger" onClick={() => purge(e.id, e.title)} disabled={e.restoring}>
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
