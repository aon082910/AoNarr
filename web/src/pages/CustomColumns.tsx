import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";
import type { CustomColumn, MediaType } from "../types.js";
import Modal from "../components/Modal.js";
import { PlusCircleIcon } from "../components/NavIcons.js";
import { PageToolbar, ToolbarButton } from "../components/PageToolbar.js";

/** Human-friendly options for the fields most people actually want as a column — picking one fills
 * in the dot-path for you. "Custom (advanced)" drops back to typing a raw path by hand, for
 * anything not listed here (a specific metadata provider's data, e.g. extraMetadata.tmdb.overview). */
const FIELD_PRESETS: { key: string; label: string; path: string }[] = [
  { key: "videoCodec", label: "Video codec", path: "mediaInfo.videoCodec" },
  { key: "audioCodec", label: "Audio codec", path: "mediaInfo.audioCodec" },
  { key: "width", label: "Video width (px)", path: "mediaInfo.width" },
  { key: "height", label: "Video height (px)", path: "mediaInfo.height" },
  { key: "bitrateKbps", label: "Bitrate (kbps)", path: "mediaInfo.bitrateKbps" },
  { key: "frameRate", label: "Frame rate", path: "mediaInfo.frameRate" },
  { key: "hdrFormat", label: "HDR format", path: "mediaInfo.hdrFormat" },
  { key: "bitDepth", label: "Bit depth", path: "mediaInfo.bitDepth" },
  { key: "colorSpace", label: "Color space", path: "mediaInfo.colorSpace" },
  { key: "audioChannels", label: "Audio channels", path: "mediaInfo.audioChannels" },
  { key: "durationSeconds", label: "Duration (seconds)", path: "mediaInfo.durationSeconds" },
  { key: "contentRating", label: "Content rating", path: "contentRating" },
  { key: "quality", label: "Quality", path: "quality" },
  { key: "custom", label: "Custom (advanced) — type a path", path: "" },
];

function presetForPath(path: string): string {
  return FIELD_PRESETS.find((p) => p.path === path)?.key ?? "custom";
}

/** `media_items.quality`/`.media_info` are only ever populated on the parent row for "single"-shape
 * types (importer.ts writes media_info onto the episode/sub_item row instead for episodic/collection
 * shapes) — same class of bug LibraryType.tsx's own SINGLE_SHAPE_ONLY_FIELDS documents and guards
 * against for its built-in field toggles. Offering these presets for a specific non-single library
 * type here would silently produce an always-blank column. */
const SINGLE_SHAPE_ONLY_PRESETS = new Set([
  "videoCodec",
  "audioCodec",
  "width",
  "height",
  "bitrateKbps",
  "frameRate",
  "hdrFormat",
  "bitDepth",
  "colorSpace",
  "audioChannels",
  "durationSeconds",
  "quality",
]);

export default function CustomColumns() {
  const mediaTypes = useMediaTypes();
  const [columns, setColumns] = useState<CustomColumn[]>([]);
  const [mode, setMode] = useState<"add" | number | null>(null);
  const [label, setLabel] = useState("");
  const [fieldPreset, setFieldPreset] = useState("videoCodec");
  const [path, setPath] = useState(FIELD_PRESETS[0].path);
  const [mediaType, setMediaType] = useState<MediaType | "">("");

  function load() {
    api.get<CustomColumn[]>("/custom-columns").then(setColumns);
  }
  useEffect(load, []);

  function resetForm() {
    setLabel("");
    setFieldPreset("videoCodec");
    setPath(FIELD_PRESETS[0].path);
    setMediaType("");
  }

  function openAdd() {
    resetForm();
    setMode("add");
  }

  function openEdit(c: CustomColumn) {
    setLabel(c.label);
    setFieldPreset(presetForPath(c.path));
    setPath(c.path);
    setMediaType(c.mediaType ?? "");
    setMode(c.id);
  }

  function selectPreset(key: string) {
    setFieldPreset(key);
    const preset = FIELD_PRESETS.find((p) => p.key === key)!;
    if (key !== "custom") {
      setPath(preset.path);
      if (!label || FIELD_PRESETS.some((p) => p.label === label)) setLabel(preset.label);
    } else {
      setPath("");
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!label || !path) return;
    const body = { label, path, mediaType: mediaType || null };
    if (mode === "add") {
      await api.post("/custom-columns", body);
    } else if (typeof mode === "number") {
      await api.patch(`/custom-columns/${mode}`, body);
    }
    setMode(null);
    load();
  }

  async function remove(id: number) {
    await api.del(`/custom-columns/${id}`);
    setMode(null);
    load();
  }

  const editing = typeof mode === "number" ? columns.find((c) => c.id === mode) ?? null : null;
  const selectedTypeShape = mediaType ? mediaTypes.find((t) => t.key === mediaType)?.shape : undefined;
  // Always keep the currently-picked preset visible (so editing an existing column whose preset
  // predates a media-type change doesn't yank it out from under the select), but otherwise hide
  // single-shape-only presets once a non-single library type is chosen.
  const availablePresets = FIELD_PRESETS.filter(
    (p) => p.key === fieldPreset || !SINGLE_SHAPE_ONLY_PRESETS.has(p.key) || !mediaType || selectedTypeShape === "single"
  );

  return (
    <div>
      <h1>Custom Columns</h1>
      <p style={{ color: "var(--muted)" }}>
        Add any field from an item's metadata as a selectable column in the library list view (the
        Columns dropdown on a Library page). Pick a field from the list, or choose "Custom
        (advanced)" to type a dot-path by hand — useful for a specific metadata provider's data,
        e.g. <code>extraMetadata.tmdb.overview</code> (provider key depends on what's configured
        under Metadata Providers). Leave library type blank to show the column on every library
        type that has matching data.
      </p>

      <PageToolbar left={<ToolbarButton icon={<PlusCircleIcon />} label="Add" onClick={openAdd} title="Add custom column" />} />

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", marginBottom: 16 }}>
        {columns.map((c) => (
          <div key={c.id} className="card" onClick={() => openEdit(c)} style={{ padding: 16 }}>
            <div style={{ fontWeight: 600 }}>{c.label}</div>
            <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: 4 }}>
              {FIELD_PRESETS.find((p) => p.path === c.path)?.label ?? c.path}
            </div>
            <div style={{ marginTop: 8 }}>
              <span className="badge">{c.mediaType ? mediaTypes.find((t) => t.key === c.mediaType)?.label ?? c.mediaType : "All libraries"}</span>
            </div>
          </div>
        ))}
      </div>
      {columns.length === 0 && <p className="empty">No custom columns configured yet.</p>}

      {mode !== null && (mode === "add" || editing) && (
        <Modal title={mode === "add" ? "Add Custom Column" : `Edit — ${editing!.label}`} onClose={() => setMode(null)}>
          <form className="form-panel" onSubmit={submit} style={{ padding: 0 }}>
            <label htmlFor="customcolumns-field-1">Field</label>
            <select id="customcolumns-field-1" value={fieldPreset} onChange={(e) => selectPreset(e.target.value)}>
              {availablePresets.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>

            {fieldPreset === "custom" && (
              <>
                <label htmlFor="customcolumns-metadata-path-2">Metadata path</label>
                <input id="customcolumns-metadata-path-2" value={path} onChange={(e) => setPath(e.target.value)} required placeholder="extraMetadata.tmdb.overview" />
              </>
            )}

            <label htmlFor="customcolumns-column-label-3">Column label</label>
            <input id="customcolumns-column-label-3" value={label} onChange={(e) => setLabel(e.target.value)} required placeholder="Video codec" />

            <label htmlFor="customcolumns-library-type-blank-all-4">Library type (blank = all)</label>
            <select id="customcolumns-library-type-blank-all-4" value={mediaType} onChange={(e) => setMediaType(e.target.value as MediaType | "")}>
              <option value="">All libraries</option>
              {mediaTypes.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>

            <div className="toolbar" style={{ justifyContent: "space-between", marginTop: 8 }}>
              <button type="submit">{mode === "add" ? "Add column" : "Save"}</button>
              {mode !== "add" && (
                <button type="button" className="danger" onClick={() => remove(mode as number)}>
                  Delete
                </button>
              )}
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
