import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client.js";
import { useSortableTable } from "../hooks/useSortableTable.js";
import { SearchIcon } from "../components/NavIcons.js";
import { ArrowRightIcon } from "../components/ActionIcons.js";

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
  const { sortRows, sortableHeader } = useSortableTable<MissingRow, "media" | "item">("media");
  const sorted = sortRows(rows, (a, b, key) =>
    key === "media" ? a.mediaTitle.localeCompare(b.mediaTitle) : a.label.localeCompare(b.label)
  );
  return (
    <>
      <h2>
        {title} <span style={{ color: "var(--muted)", fontWeight: 400 }}>({rows.length})</span>
        {rows.length > 0 && (
          <button type="button" className="icon-button" style={{ marginLeft: 10, width: 26, height: 26 }} onClick={() => onSearchMany(rows)} title="Search all" aria-label="Search all">
            <SearchIcon />
          </button>
        )}
      </h2>
      {rows.length === 0 && <p className="empty">Nothing missing.</p>}
      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th></th>
              {sortableHeader("media", "Media")}
              {sortableHeader("item", "Item")}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, idx) => (
              <tr key={idx}>
                <td>
                  <input type="checkbox" checked={selected.has(rowKey(r))} onChange={() => onToggle(r)} />
                </td>
                <td>{r.mediaTitle}</td>
                <td>{r.label}</td>
                <td style={{ display: "flex", gap: 6 }}>
                  <button type="button" className="icon-button" onClick={() => onSearchOne(r)} title="Search" aria-label="Search">
                    <SearchIcon />
                  </button>
                  <Link to={`/media/${r.mediaItemId}`}>
                    <button type="button" className="icon-button" title="Open" aria-label="Open">
                      <ArrowRightIcon />
                    </button>
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
          <button type="button" className="icon-button" style={{ marginLeft: 10, width: 26, height: 26 }} onClick={() => onSearchMany(rows)} title="Search all" aria-label="Search all">
            <SearchIcon />
          </button>
        )}
      </h2>
      {rows.length === 0 && <p className="empty">Nothing missing.</p>}
      {Object.entries(bySeries).map(([id, group]) => {
        const seriesId = Number(id);
        const isOpen = openSeries.has(seriesId);
        return (
          <div key={id} style={{ marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button
                type="button"
                onClick={() => toggleOpen(seriesId)}
                aria-expanded={isOpen}
                style={{ background: "transparent", border: "none", padding: 0, margin: 0, color: "inherit", font: "inherit", cursor: "pointer" }}
              >
                <strong>
                  {isOpen ? "▾" : "▸"} {group.title} ({group.rows.length})
                </strong>
              </button>
              <button
                type="button"
                className="icon-button"
                title="Search all missing in this series"
                aria-label="Search all missing in this series"
                onClick={(e) => {
                  e.stopPropagation();
                  onSearchMany(group.rows);
                }}
              >
                <SearchIcon />
              </button>
            </div>
            {isOpen && <SeriesEpisodeTable rows={group.rows} selected={selected} onToggle={onToggle} onSearchOne={onSearchOne} />}
          </div>
        );
      })}
    </>
  );
}

function SeriesEpisodeTable({
  rows,
  selected,
  onToggle,
  onSearchOne,
}: {
  rows: MissingRow[];
  selected: Set<string>;
  onToggle: (r: MissingRow) => void;
  onSearchOne: (r: MissingRow) => void;
}) {
  const { sortRows, sortableHeader } = useSortableTable<MissingRow, "episode">("episode");
  const sorted = sortRows(rows, (a, b) => a.label.localeCompare(b.label));
  return (
    <table style={{ marginTop: 4 }}>
      <thead>
        <tr>
          <th></th>
          {sortableHeader("episode", "Episode")}
          <th></th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((r, idx) => (
          <tr key={idx}>
            <td>
              <input type="checkbox" checked={selected.has(rowKey(r))} onChange={() => onToggle(r)} />
            </td>
            <td>{r.label}</td>
            <td style={{ display: "flex", gap: 6 }}>
              <button type="button" className="icon-button" onClick={() => onSearchOne(r)} title="Search" aria-label="Search">
                <SearchIcon />
              </button>
              <Link to={`/media/${r.mediaItemId}`}>
                <button type="button" className="icon-button" title="Open" aria-label="Open">
                  <ArrowRightIcon />
                </button>
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
          <button type="button" className="icon-button" onClick={bulkSearch} disabled={searching} title={searching ? "Searching..." : "Search selected"} aria-label="Search selected">
            <SearchIcon />
          </button>
          <button type="button" className="secondary" onClick={() => setSelected(new Set())}>
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
