import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client.js";

interface MissingRow {
  mediaItemId: number;
  mediaTitle: string;
  type: string;
  episodeId: number | null;
  subItemId: number | null;
  label: string;
  sortKey: string | null;
}

interface MissingResponse {
  movies: MissingRow[];
  episodes: MissingRow[];
  subItems: MissingRow[];
}

function rowKey(r: MissingRow): string {
  return `${r.mediaItemId}:${r.episodeId ?? ""}:${r.subItemId ?? ""}`;
}

function Section({
  title,
  rows,
  selected,
  onToggle,
}: {
  title: string;
  rows: MissingRow[];
  selected: Set<string>;
  onToggle: (r: MissingRow) => void;
}) {
  return (
    <>
      <h2>
        {title} <span style={{ color: "var(--muted)", fontWeight: 400 }}>({rows.length})</span>
      </h2>
      {rows.length === 0 && <p className="empty">Nothing missing.</p>}
      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Media</th>
              <th>Item</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={idx}>
                <td>
                  <input type="checkbox" checked={selected.has(rowKey(r))} onChange={() => onToggle(r)} />
                </td>
                <td>{r.mediaTitle}</td>
                <td>{r.label}</td>
                <td>
                  <Link to={`/media/${r.mediaItemId}`}>
                    <button className="secondary">Open</button>
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

export default function Missing() {
  const [data, setData] = useState<MissingResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [byKey, setByKey] = useState<Map<string, MissingRow>>(new Map());
  const [searching, setSearching] = useState(false);

  function load() {
    api.get<MissingResponse>("/wanted/missing").then((d) => {
      setData(d);
      const map = new Map<string, MissingRow>();
      for (const r of [...d.movies, ...d.episodes, ...d.subItems]) map.set(rowKey(r), r);
      setByKey(map);
      setSelected(new Set());
    });
  }

  useEffect(load, []);

  function toggle(r: MissingRow) {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = rowKey(r);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function bulkSearch() {
    setSearching(true);
    try {
      const targets = Array.from(selected)
        .map((key) => byKey.get(key))
        .filter((r): r is MissingRow => !!r)
        .map((r) => ({ mediaItemId: r.mediaItemId, episodeId: r.episodeId, subItemId: r.subItemId }));
      const results = await api.post<{ grabbed: boolean; error?: string }[]>("/search/bulk", { targets });
      const grabbedCount = results.filter((r) => r.grabbed).length;
      alert(`Grabbed ${grabbedCount} of ${results.length} selected item(s).`);
      load();
    } finally {
      setSearching(false);
    }
  }

  if (!data) return <p className="empty">Loading...</p>;

  return (
    <div>
      <h1>Missing</h1>
      {selected.size > 0 && (
        <div className="form-panel" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <strong>{selected.size} selected</strong>
          <button className="secondary" onClick={bulkSearch} disabled={searching}>
            {searching ? "Searching..." : "Search selected"}
          </button>
          <button className="secondary" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}
      <Section title="Movies" rows={data.movies} selected={selected} onToggle={toggle} />
      <Section title="Episodes" rows={data.episodes} selected={selected} onToggle={toggle} />
      <Section title="Albums & Books" rows={data.subItems} selected={selected} onToggle={toggle} />
    </div>
  );
}
