import { type ReactNode, useState } from "react";
import Modal from "./Modal.js";

export interface SettingsSectionDef {
  /** Unique within this grid — used as the React key and the modal's own identity. */
  key: string;
  label: string;
  description?: string;
  /** Optional badge text (e.g. "3 folders", "Configured") — omit for sections with no natural
   * on/off or count state, where a badge would just be noise. */
  badge?: string;
  badgeOk?: boolean;
  maxWidth?: number;
  /** Renders the section's own existing content, unchanged, inside the popup. */
  render: () => ReactNode;
}

/**
 * Same tile-grid + popup pattern as SettingsProviderTiles, generalized for sections whose content
 * isn't a flat key/value field list — Root Folders, Quality Profiles, Custom Formats, and similar
 * sections keep their own existing table/CRUD UI verbatim; this component only supplies the tile
 * entry point and the Modal shell around it.
 */
export default function SettingsSectionTiles({ sections }: { sections: SettingsSectionDef[] }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const openSection = sections.find((s) => s.key === openKey) ?? null;

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
        {sections.map((s) => (
          <div key={s.key} className="card" onClick={() => setOpenKey(s.key)} style={{ padding: 16 }}>
            <div style={{ fontWeight: 600 }}>{s.label}</div>
            {s.description && (
              <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: 4 }}>{s.description}</div>
            )}
            {s.badge && (
              <span className={`badge ${s.badgeOk ? "ok" : ""}`} style={{ marginTop: 8, display: "inline-block" }}>
                {s.badge}
              </span>
            )}
          </div>
        ))}
      </div>

      {openSection && (
        <Modal title={openSection.label} onClose={() => setOpenKey(null)} maxWidth={openSection.maxWidth ?? 680}>
          {openSection.render()}
        </Modal>
      )}
    </>
  );
}
