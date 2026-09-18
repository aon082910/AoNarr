import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import { LayersIcon } from "../components/NavIcons.js";
import { TrashIcon } from "../components/ActionIcons.js";
import type { Collection } from "../types.js";

export default function Collections() {
  const navigate = useNavigate();
  const mediaTypes = useMediaTypes();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const [isSmart, setIsSmart] = useState(false);
  const [filterType, setFilterType] = useState("");
  const [filterMonitored, setFilterMonitored] = useState("");
  const [filterHasFile, setFilterHasFile] = useState("");
  const [filterAddedAfterDays, setFilterAddedAfterDays] = useState("");

  function load() {
    api.get<Collection[]>("/collections").then(setCollections);
  }
  useEffect(load, []);

  async function addCollection(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const smartFilter = isSmart
      ? {
          type: filterType || undefined,
          monitored: filterMonitored === "" ? undefined : Number(filterMonitored),
          hasFile: filterHasFile === "" ? undefined : Number(filterHasFile),
          addedAfterDays: filterAddedAfterDays ? Number(filterAddedAfterDays) : undefined,
        }
      : undefined;
    try {
      const created = await api.post<Collection>("/collections", {
        name: name.trim(),
        description: description || null,
        smartFilter,
      });
      setName("");
      setDescription("");
      setIsSmart(false);
      setFilterType("");
      setFilterMonitored("");
      setFilterHasFile("");
      setFilterAddedAfterDays("");
      navigate(`/collections/${created.id}`);
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function removeCollection(id: number) {
    if (!confirm("Delete this collection? Media items themselves are not affected.")) return;
    try {
      await api.del(`/collections/${id}`);
      load();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  return (
    <div>
      <h1>Collections</h1>
      <p style={{ color: "var(--muted)" }}>
        Optional groupings that can span any library — e.g. a movie, its comic source, and its
        soundtrack album, all in one place.
      </p>

      <form className="form-panel" onSubmit={addCollection}>
        <label htmlFor="collections-name-1">Name</label>
        <input id="collections-name-1" value={name} onChange={(e) => setName(e.target.value)} required />
        <label htmlFor="collections-description-2">Description</label>
        <input id="collections-description-2" value={description} onChange={(e) => setDescription(e.target.value)} />
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={isSmart} onChange={(e) => setIsSmart(e.target.checked)} />
          Smart collection (live filter, not a fixed list)
        </label>
        {isSmart && (
          <>
            <p style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
              Membership is re-computed every time the collection is viewed — items aren't added or
              removed manually.
            </p>
            <label htmlFor="collections-library-type-3">Library type</label>
            <select id="collections-library-type-3" value={filterType} onChange={(e) => setFilterType(e.target.value)}>
              <option value="">Any</option>
              {mediaTypes.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
            <label htmlFor="collections-monitored-4">Monitored</label>
            <select id="collections-monitored-4" value={filterMonitored} onChange={(e) => setFilterMonitored(e.target.value)}>
              <option value="">Any</option>
              <option value="1">Monitored</option>
              <option value="0">Unmonitored</option>
            </select>
            <label htmlFor="collections-file-status-5">File status</label>
            <select id="collections-file-status-5" value={filterHasFile} onChange={(e) => setFilterHasFile(e.target.value)}>
              <option value="">Any</option>
              <option value="1">Downloaded</option>
              <option value="0">Missing</option>
            </select>
            <label htmlFor="collections-added-within-last-n-days-blank-any-time-6">Added within last N days (blank = any time)</label>
            <input id="collections-added-within-last-n-days-blank-any-time-6"
              type="number"
              style={{ maxWidth: 120 }}
              value={filterAddedAfterDays}
              onChange={(e) => setFilterAddedAfterDays(e.target.value)}
            />
          </>
        )}
        <button type="submit">Create collection</button>
      </form>

      {collections.length === 0 && <p className="empty">No collections yet.</p>}
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
        {collections.map((c) => (
          <div key={c.id} className="card" onClick={() => navigate(`/collections/${c.id}`)} style={{ cursor: "pointer" }}>
            {c.posterUrls && c.posterUrls.length > 0 ? (
              <div
                className="poster"
                style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr", gap: 1, background: "var(--border)" }}
              >
                {Array.from({ length: 4 }).map((_, i) =>
                  c.posterUrls![i] ? (
                    <div key={i} style={{ backgroundImage: `url(${c.posterUrls![i]})`, backgroundSize: "cover", backgroundPosition: "center" }} />
                  ) : (
                    <div key={i} style={{ background: "var(--panel)" }} />
                  )
                )}
              </div>
            ) : (
              <div className="poster" style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)" }}>
                <LayersIcon />
              </div>
            )}
            <div className="meta">
              <div className="title">
                {c.name}
                {c.smartFilter && (
                  <span className="badge" style={{ marginLeft: 6 }}>
                    Smart
                  </span>
                )}
              </div>
              <div className="sub">
                {c.itemCount ?? 0} item{c.itemCount === 1 ? "" : "s"}
                {c.description ? ` · ${c.description}` : ""}
              </div>
            </div>
            <button
              type="button"
              className="icon-button danger"
              onClick={(e) => {
                e.stopPropagation();
                removeCollection(c.id);
              }}
              style={{ margin: "0 12px 12px" }}
              title="Delete"
              aria-label="Delete"
            >
              <TrashIcon />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
