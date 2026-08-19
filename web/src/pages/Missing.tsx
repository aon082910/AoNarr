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

function toTarget(r: MissingRow) {
  return { mediaItemId: r.mediaItemId, episodeId: r.episodeId, subItemId: r.subItemId };
}

function Section({
  title,
  rows,
  selected,
  onToggle,
  onSearchOne,
  onSearchMany,
}: {
  title: string;
  rows: MissingRow[];
  selected: Set<string>;
  onToggle: (r: MissingRow) => void;
  onSearchOne: (r: MissingRow) => void;
  onSearchMany: (rows: MissingRow[]) => void;
}) {
  return (
    <>
      <h2>
        {title} <span style={{ color: "var(--muted)", fontWeight: 400 }}>({rows.length})</span>
        {rows.length > 0 && (
          <button className="secondary" style={{ marginLeft: 10, fontSize: "0.8rem" }} onClick={() => onSearchMany(rows)}>
            Search all
          </button>
        )}
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
                <td style={{ display: "flex", gap: 6 }}>
                  <button className="secondary" onClick={() => onSearchOne(r)}>
                    Search
                  </button>
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

/** Episodes grouped by series, each with its own "Search all missing in this series" — the
 * flat episode list otherwise makes searching "everything missing from one show" a lot of
 * individual clicks. */
function EpisodesBySeries({
  rows,
  selected,
  onToggle,
  onSearchOne,
  onSearchMany,
}: {
  rows: MissingRow[];
  selected: Set<string>;
  onToggle: (r: MissingRow) => void;
  onSearchOne: (r: MissingRow) => void;
  onSearchMany: (rows: MissingRow[]) => void;
}) {
  const [openSeries, setOpenSeries] = useState<Set<number>>(new Set());
  const bySeries = rows.reduce<Record<number, { title: string; rows: MissingRow[] }>>((acc, r) => {
    (acc[r.mediaItemId] ??= { title: r.mediaTitle, rows: [] }).rows.push(r);
    return acc;
  }, {});

  function toggleOpen(id: number) {
    setOpenSeries((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <>
      <h2>
        Episodes <span style={{ color: "var(--muted)", fontWeight: 400 }}>({rows.length})</span>
        {rows.length > 0 && (
          <button className="secondary" style={{ marginLeft: 10, fontSize: "0.8rem" }} onClick={() => onSearchMany(rows)}>
            Search all
          </button>
        )}
      </h2>
      {rows.length === 0 && <p className="empty">Nothing missing.</p>}
      {Object.entries(bySeries).map(([id, group]) => {
        const seriesId = Number(id);
        const isOpen = openSeries.has(seriesId);
        return (
          <div key={id} style={{ marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={() => toggleOpen(seriesId)}>
              <strong>
                {isOpen ? "▾" : "▸"} {group.title} ({group.rows.length})
              </strong>
              <button
                className="secondary"
                style={{ fontSize: "0.8rem" }}
                onClick={(e) => {
                  e.stopPropagation();
                  onSearchMany(group.rows);
                }}
              >
                Search all missing in this series
              </button>
            </div>
            {isOpen && (
              <table style={{ marginTop: 4 }}>
                <thead>
                  <tr>
                    <th></th>
                    <th>Episode</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((r, idx) => (
                    <tr key={idx}>
                      <td>
                        <input type="checkbox" checked={selected.has(rowKey(r))} onChange={() => onToggle(r)} />
                      </td>
                      <td>{r.label}</td>
                      <td style={{ display: "flex", gap: 6 }}>
                        <button className="secondary" onClick={() => onSearchOne(r)}>
                          Search
                        </button>
                        <Link to={`/media/${r.mediaItemId}`}>
                          <button className="secondary">Open</button>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
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

  async function searchRows(rows: MissingRow[]) {
    setSearching(true);
    try {
      const results = await api.post<{ grabbed: boolean; error?: string }[]>("/search/bulk", {
        targets: rows.map(toTarget),
      });
      const grabbedCount = results.filter((r) => r.grabbed).length;
      alert(`Grabbed ${grabbedCount} of ${results.length} item(s).`);
      load();
    } finally {
      setSearching(false);
    }
  }

  async function bulkSearch() {
    const rows = Array.from(selected)
      .map((key) => byKey.get(key))
      .filter((r): r is MissingRow => !!r);
    await searchRows(rows);
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
      <Section
        title="Movies"
        rows={data.movies}
        selected={selected}
        onToggle={toggle}
        onSearchOne={(r) => searchRows([r])}
        onSearchMany={searchRows}
      />
      <EpisodesBySeries
        rows={data.episodes}
        selected={selected}
        onToggle={toggle}
        onSearchOne={(r) => searchRows([r])}
        onSearchMany={searchRows}
      />
      <Section
        title="Albums & Books"
        rows={data.subItems}
        selected={selected}
        onToggle={toggle}
        onSearchOne={(r) => searchRows([r])}
        onSearchMany={searchRows}
      />
    </div>
  );
}
