import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import SearchMatchModal, { type MetadataSearchResult } from "../components/SearchMatchModal.js";
import { useSortableTable } from "../hooks/useSortableTable.js";
import { SearchIcon } from "../components/NavIcons.js";
import { XIcon } from "../components/ActionIcons.js";
import { notify } from "../utils/notify.js";
import { confirmDialog } from "../utils/confirmDialog.js";
import Pagination, { DEFAULT_PAGE_SIZE_OPTIONS } from "../components/Pagination.js";

interface ReviewItem {
  id: number;
  source: string;
  importListId: number | null;
  type: string;
  title: string;
  year: number | null;
  status: string;
  createdAt: string;
}

interface ReviewListResponse {
  items: ReviewItem[];
  total: number;
}

/**
 * Titles Watchlist Import or a recurring Import List's sync couldn't confidently match to a
 * metadata provider result — previously discarded silently, now queued here so an admin can pick
 * the right match by hand (or dismiss it as not worth adding) instead of it just vanishing.
 */
export default function ImportReview() {
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(() => Number(localStorage.getItem("aonarr_importreview_page_size")) || 60);
  const [metadataProviders, setMetadataProviders] = useState<Record<string, string[]>>({});
  const [matching, setMatching] = useState<ReviewItem | null>(null);

  function load() {
    const offset = (page - 1) * pageSize;
    api.get<ReviewListResponse>(`/import-review?status=pending&limit=${pageSize}&offset=${offset}`).then((data) => {
      setItems(data.items);
      setTotal(data.total);
    });
  }

  useEffect(load, [page, pageSize]);
  useEffect(() => {
    localStorage.setItem("aonarr_importreview_page_size", String(pageSize));
  }, [pageSize]);
  useEffect(() => {
    api.get<Record<string, string[]>>("/metadata/providers").then(setMetadataProviders);
  }, []);

  async function applyMatch(item: ReviewItem, result: MetadataSearchResult) {
    try {
      await api.post("/metadata/import", {
        type: item.type,
        title: result.title,
        year: result.year,
        overview: result.overview,
        posterUrl: result.posterUrl,
        externalIds: result.externalIds,
      });
    } catch (e) {
      notify.error(`Import failed: ${(e as Error).message}`);
      return;
    }
    setMatching(null);
    try {
      await api.post(`/import-review/${item.id}/resolve`, {});
    } catch (e) {
      // The library item above was already created successfully — only marking this review row
      // resolved failed. Surfacing that distinction matters: retrying the match here would create
      // a duplicate library item, since the import itself already went through.
      notify.error(`"${item.title}" was imported, but marking it resolved failed: ${(e as Error).message}. Don't match it again — reload this page instead.`);
    }
    load();
  }

  async function dismiss(item: ReviewItem) {
    if (
      !(await confirmDialog({
        title: "Dismiss item",
        message: `Dismiss "${item.title}"? It won't be re-queued unless it's removed from its source list and re-added later.`,
      }))
    )
      return;
    await api.post(`/import-review/${item.id}/dismiss`, {});
    load();
  }

  const { sortRows, sortableHeader } = useSortableTable<ReviewItem, "title" | "year" | "type" | "source" | "queued">("queued", "desc");
  const sorted = items
    ? sortRows(items, (a, b, key) => {
        if (key === "title") return a.title.localeCompare(b.title);
        if (key === "year") return (a.year ?? 0) - (b.year ?? 0);
        if (key === "type") return a.type.localeCompare(b.type);
        if (key === "source") return a.source.localeCompare(b.source);
        return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
      })
    : [];

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  if (!items) return <p className="empty">Loading...</p>;

  return (
    <div>
      <h1>Import Review</h1>
      <p style={{ color: "var(--muted)" }}>
        Titles from Watchlist Import or a recurring Import List that couldn't be confidently
        matched to a metadata provider result. Search for the right match by hand, or dismiss the
        ones you don't want.
      </p>

      {items.length === 0 && <p className="empty">Nothing needs review right now.</p>}
      {items.length > 0 && (
        <>
          <table>
            <thead>
              <tr>
                {sortableHeader("title", "Title")}
                {sortableHeader("year", "Year")}
                {sortableHeader("type", "Type")}
                {sortableHeader("source", "Source")}
                {sortableHeader("queued", "Queued")}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((item) => (
                <tr key={item.id}>
                  <td>{item.title}</td>
                  <td>{item.year ?? "-"}</td>
                  <td>{item.type}</td>
                  <td>{item.source === "watchlist" ? "Watchlist Import" : item.source}</td>
                  <td>{item.createdAt}</td>
                  <td style={{ display: "flex", gap: 6 }}>
                    <button type="button" className="icon-button" onClick={() => setMatching(item)} title="Match..." aria-label="Match">
                      <SearchIcon />
                    </button>
                    <button type="button" className="icon-button danger" onClick={() => dismiss(item)} title="Dismiss" aria-label="Dismiss">
                      <XIcon />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination
            page={page}
            totalPages={totalPages}
            total={total}
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

      {matching && (
        <SearchMatchModal
          type={matching.type}
          initialQuery={matching.year ? `${matching.title} ${matching.year}` : matching.title}
          providers={metadataProviders[matching.type] ?? []}
          onClose={() => setMatching(null)}
          onSelect={(result) => applyMatch(matching, result)}
          title="Match and add to library"
          description="Search for the right result and pick it to add this as a new library item, monitored, and clear it from the review queue."
        />
      )}
    </div>
  );
}
