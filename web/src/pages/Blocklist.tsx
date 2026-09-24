import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client.js";
import { useSortableTable } from "../hooks/useSortableTable.js";
import type { BlocklistEntry } from "../types.js";
import { TrashIcon } from "../components/ActionIcons.js";
import { PageToolbar, ToolbarButton } from "../components/PageToolbar.js";
import { notify } from "../utils/notify.js";
import { confirmDialog } from "../utils/confirmDialog.js";
import Pagination, { DEFAULT_PAGE_SIZE_OPTIONS } from "../components/Pagination.js";
import { formatServerTimestamp } from "../utils/format.js";

interface BlocklistResponse {
  items: BlocklistEntry[];
  total: number;
}

/** Radarr/Sonarr-style Blocklist page — every release AoNarr has been told never to grab again
 * (via the "Blocklist" button on a search result, or an automatic retry-after-failure), with a
 * per-entry or bulk "remove" to let something back in. */
export default function Blocklist() {
  const [data, setData] = useState<BlocklistResponse | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(() => Number(localStorage.getItem("aonarr_blocklist_page_size")) || 100);

  function load() {
    const offset = (page - 1) * pageSize;
    api.get<BlocklistResponse>(`/blocklist?limit=${pageSize}&offset=${offset}`).then((res) => {
      // Past the end (the last entries on this page were removed) — step back instead of showing
      // "Nothing blocklisted." with no pagination while entries remain on earlier pages.
      if (res.items.length === 0 && page > 1) {
        setPage(Math.min(page - 1, Math.max(1, Math.ceil(res.total / pageSize))));
        return;
      }
      setData(res);
    });
  }

  useEffect(load, [page, pageSize]);

  // Removing entries only filters the local copy, so once every visible row is gone the page must
  // be refetched to pull in whatever remains on the server.
  const pageEmptied = !!data && data.items.length === 0 && data.total > 0;
  useEffect(() => {
    if (pageEmptied) load();
  }, [pageEmptied]);

  useEffect(() => {
    localStorage.setItem("aonarr_blocklist_page_size", String(pageSize));
  }, [pageSize]);

  async function remove(id: number) {
    try {
      await api.del(`/blocklist/${id}`);
      setData((prev) => (prev ? { items: prev.items.filter((e) => e.id !== id), total: prev.total - 1 } : null));
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  async function clearAll() {
    if (!data || data.total === 0) return;
    if (!(await confirmDialog({ title: "Clear blocklist", message: `Remove all ${data.total} blocklist entries? This lets every one of them be grabbed again.` })))
      return;
    try {
      await api.del("/blocklist");
      setData({ items: [], total: 0 });
      setPage(1);
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  const { sortRows, sortableHeader } = useSortableTable<BlocklistEntry, "media" | "release" | "reason" | "date">("date", "desc");
  const sorted = data
    ? sortRows(data.items, (a, b, key) => {
        if (key === "media") return a.mediaTitle.localeCompare(b.mediaTitle);
        if (key === "release") return a.releaseTitle.localeCompare(b.releaseTitle);
        if (key === "reason") return (a.reason ?? "").localeCompare(b.reason ?? "");
        return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
      })
    : [];

  if (!data) return <p className="empty">Loading...</p>;

  const totalPages = Math.max(1, Math.ceil(data.total / pageSize));

  return (
    <div>
      <h1>Blocklist</h1>
      <p style={{ color: "var(--muted)" }}>
        Releases AoNarr won't grab again — added manually from a search result, or automatically
        after a grab fails to import. Remove an entry to let it be considered again.
      </p>
      {data.items.length > 0 && (
        <PageToolbar
          left={<ToolbarButton icon={<TrashIcon />} label="Clear All" onClick={clearAll} danger title="Clear blocklist" />}
        />
      )}
      {data.items.length === 0 && <p className="empty">Nothing blocklisted.</p>}
      {data.items.length > 0 && (
        <>
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
                  <td>{formatServerTimestamp(e.createdAt)}</td>
                  <td>
                    <button type="button" className="icon-button" onClick={() => remove(e.id)} title="Remove" aria-label="Remove">
                      <TrashIcon />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination
            page={page}
            totalPages={totalPages}
            total={data.total}
            pageSize={pageSize}
            hasPrev={page > 1}
            hasNext={page < totalPages}
            onPrev={() => setPage((p) => p - 1)}
            onNext={() => setPage((p) => p + 1)}
            onPageSizeChange={(n) => {
              setPageSize(n);
              setPage(1);
            }}
            pageSizeOptions={DEFAULT_PAGE_SIZE_OPTIONS}
          />
        </>
      )}
    </div>
  );
}
