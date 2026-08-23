import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import SearchMatchModal, { type MetadataSearchResult } from "../components/SearchMatchModal.js";

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

/**
 * Titles Watchlist Import or a recurring Import List's sync couldn't confidently match to a
 * metadata provider result — previously discarded silently, now queued here so an admin can pick
 * the right match by hand (or dismiss it as not worth adding) instead of it just vanishing.
 */
export default function ImportReview() {
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [metadataProviders, setMetadataProviders] = useState<Record<string, string[]>>({});
  const [matching, setMatching] = useState<ReviewItem | null>(null);

  function load() {
    api.get<ReviewItem[]>("/import-review?status=pending").then(setItems);
  }

  useEffect(load, []);
  useEffect(() => {
    api.get<Record<string, string[]>>("/metadata/providers").then(setMetadataProviders);
  }, []);

  async function applyMatch(item: ReviewItem, result: MetadataSearchResult) {
    await api.post("/metadata/import", {
      type: item.type,
      title: result.title,
      year: result.year,
      overview: result.overview,
      posterUrl: result.posterUrl,
      externalIds: result.externalIds,
    });
    await api.post(`/import-review/${item.id}/resolve`, {});
    setMatching(null);
    load();
  }

  async function dismiss(item: ReviewItem) {
    if (!confirm(`Dismiss "${item.title}"? It won't be re-queued unless it's removed from its source list and re-added later.`)) return;
    await api.post(`/import-review/${item.id}/dismiss`, {});
    load();
  }

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
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Year</th>
              <th>Type</th>
              <th>Source</th>
              <th>Queued</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.title}</td>
                <td>{item.year ?? "-"}</td>
                <td>{item.type}</td>
                <td>{item.source === "watchlist" ? "Watchlist Import" : item.source}</td>
                <td>{item.createdAt}</td>
                <td style={{ display: "flex", gap: 6 }}>
                  <button className="secondary" onClick={() => setMatching(item)}>
                    Match...
                  </button>
                  <button className="danger" onClick={() => dismiss(item)}>
                    Dismiss
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
