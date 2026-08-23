import { useRef, useState } from "react";
import Modal from "./Modal.js";

type MediaShape = "single" | "episodic" | "collection";

interface TokenOption {
  token: string;
  label: string;
}

const TOKENS_BY_SHAPE: Record<MediaShape, TokenOption[]> = {
  single: [
    { token: "{title}", label: "Title" },
    { token: "{year}", label: "Year" },
  ],
  episodic: [
    { token: "{parentTitle}", label: "Show title" },
    { token: "{season:00}", label: "Season (zero-padded)" },
    { token: "{episode:00}", label: "Episode (zero-padded)" },
    { token: "{absoluteEpisode:000}", label: "Absolute episode (anime-style)" },
  ],
  collection: [
    { token: "{parentTitle}", label: "Artist/Author/Creator" },
    { token: "{childTitle}", label: "Album/Book/Issue" },
  ],
};

const PREVIEW_VARS_BY_SHAPE: Record<MediaShape, Record<string, string | number>> = {
  single: { title: "Example Movie", year: 2020 },
  episodic: { parentTitle: "Example Show", season: 1, episode: 5, absoluteEpisode: 5 },
  collection: { parentTitle: "Example Artist", childTitle: "Example Album" },
};

/** Same rendering rule the server's naming.ts uses — kept in sync deliberately so the live preview
 * here matches exactly what an actual import would produce. */
function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)(?::(0+))?\}/g, (_match, key: string, pad: string | undefined) => {
    const value = vars[key];
    if (value === undefined || value === null) return "";
    if (pad && typeof value === "number") return String(value).padStart(pad.length, "0");
    return String(value);
  });
}

export default function NamingSetupModal({
  typeLabel,
  shape,
  defaultTemplate,
  initialTemplate,
  initialEnabled,
  onClose,
  onSave,
}: {
  typeLabel: string;
  shape: MediaShape;
  defaultTemplate: string;
  initialTemplate: string;
  initialEnabled: boolean;
  onClose: () => void;
  onSave: (template: string, enabled: boolean) => Promise<void>;
}) {
  const [template, setTemplate] = useState(initialTemplate);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function insertToken(token: string) {
    const input = inputRef.current;
    if (!input) {
      setTemplate((prev) => prev + token);
      return;
    }
    const start = input.selectionStart ?? template.length;
    const end = input.selectionEnd ?? template.length;
    const next = template.slice(0, start) + token + template.slice(end);
    setTemplate(next);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function save() {
    setSaving(true);
    try {
      await onSave(template, enabled);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  const preview = enabled
    ? renderTemplate(template, PREVIEW_VARS_BY_SHAPE[shape])
    : `(kept as originally downloaded — only the folder structure "${renderTemplate(template, PREVIEW_VARS_BY_SHAPE[shape]).split("/").slice(0, -1).join("/") || "(root)"}" still applies)`;

  return (
    <Modal title={`Naming setup — ${typeLabel}`} onClose={onClose} maxWidth={560}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <input id="naming-enabled" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} style={{ width: "auto" }} />
        <label htmlFor="naming-enabled" style={{ margin: 0, cursor: "pointer" }}>
          Rename files on import using this template
        </label>
      </div>
      {!enabled && (
        <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: -6 }}>
          Files keep their downloaded filename. The template's folder structure (everything before
          the last <code>/</code>) still applies, so files stay organized — only the filename itself
          is left alone.
        </p>
      )}

      <label>Template</label>
      <input ref={inputRef} value={template} onChange={(e) => setTemplate(e.target.value)} disabled={!enabled} style={{ fontFamily: "monospace" }} />

      <p style={{ color: "var(--muted)", fontSize: "0.8rem", margin: "10px 0 4px" }}>Insert a token:</p>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {TOKENS_BY_SHAPE[shape].map((opt) => (
          <button
            key={opt.token}
            type="button"
            className="secondary"
            disabled={!enabled}
            onClick={() => insertToken(opt.token)}
            title={opt.label}
            style={{ fontFamily: "monospace", fontSize: "0.8rem" }}
          >
            {opt.token}
          </button>
        ))}
      </div>

      <div className="form-panel" style={{ marginBottom: 16 }}>
        <label style={{ marginTop: 0 }}>Preview</label>
        <p style={{ fontFamily: "monospace", margin: 0, wordBreak: "break-all" }}>{preview}</p>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={save} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </button>
        <button type="button" className="secondary" onClick={() => setTemplate(defaultTemplate)} disabled={!enabled}>
          Reset to default
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
