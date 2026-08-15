import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
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
  }

  async function removeCollection(id: number) {
    if (!confirm("Delete this collection? Media items themselves are not affected.")) return;
    await api.del(`/collections/${id}`);
    load();
  }

  return (
    <div>
      <h1>Collections</h1>
      <p style={{ color: "var(--muted)" }}>
        Optional groupings that can span any library — e.g. a movie, its comic source, and its
        soundtrack album, all in one place.
      </p>

      <form className="form-panel" onSubmit={addCollection}>
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required />
        <label>Description</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
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
            <label>Library type</label>
            <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
              <option value="">Any</option>
              {mediaTypes.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
            <label>Monitored</label>
            <select value={filterMonitored} onChange={(e) => setFilterMonitored(e.target.value)}>
              <option value="">Any</option>
              <option value="1">Monitored</option>
              <option value="0">Unmonitored</option>
            </select>
            <label>File status</label>
            <select value={filterHasFile} onChange={(e) => setFilterHasFile(e.target.value)}>
              <option value="">Any</option>
              <option value="1">Downloaded</option>
              <option value="0">Missing</option>
            </select>
            <label>Added within last N days (blank = any time)</label>
            <input
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
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Description</th>
            <th>Items</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {collections.map((c) => (
            <tr key={c.id}>
              <td>
                <a onClick={() => navigate(`/collections/${c.id}`)} style={{ cursor: "pointer", color: "var(--accent)" }}>
                  {c.name}
                </a>
                {c.smartFilter && (
                  <span className="badge" style={{ marginLeft: 6 }}>
                    Smart
                  </span>
                )}
              </td>
              <td>{c.description ?? "-"}</td>
              <td>{c.itemCount ?? 0}</td>
              <td>
                <button className="danger" onClick={() => removeCollection(c.id)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
