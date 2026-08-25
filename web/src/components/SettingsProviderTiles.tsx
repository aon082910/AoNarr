import { useState } from "react";
import Modal from "./Modal.js";

export interface SettingsProviderField {
  /** Settings store key this field reads/writes (passed straight to saveSetting). */
  key: string;
  label: string;
  placeholder?: string;
  type?: "text" | "password" | "select";
  options?: { value: string; label: string }[];
  helpText?: string;
}

export interface SettingsProviderDef {
  /** Unique within this grid — used as the React key and the modal's own identity. */
  key: string;
  label: string;
  description?: string;
  fields: SettingsProviderField[];
  /** Whether this provider currently has enough set to actually do something — drives the tile's
   * "Configured"/"Not configured" badge. Given the raw settings map so the caller can express
   * whatever "configured" means for that provider (e.g. SMTP needs 3 fields, Discord needs 1). */
  isConfigured: (settings: Record<string, string>) => boolean;
}

/**
 * Tile-grid + popup-editor pattern for a settings page with many similar "providers"/integrations
 * (each with its own handful of fields) that used to be one long unbroken vertical form — Notifications
 * (Round 126) is the first page built this way; the same `SettingsProviderDef[]` shape is meant to be
 * reused for the other settings pages when the pattern is applied more broadly. Each tile shows the
 * provider's name and configured/not-configured status; clicking it opens a `Modal` with just that
 * provider's own fields, saved through the same `saveSetting` every other settings field already uses.
 */
export default function SettingsProviderTiles({
  providers,
  settings,
  saveSetting,
}: {
  providers: SettingsProviderDef[];
  settings: Record<string, string>;
  saveSetting: (key: string, value: string) => void | Promise<void>;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const openProvider = providers.find((p) => p.key === openKey) ?? null;

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
        {providers.map((p) => {
          const configured = p.isConfigured(settings);
          return (
            <div key={p.key} className="card" onClick={() => setOpenKey(p.key)} style={{ padding: 16 }}>
              <div style={{ fontWeight: 600 }}>{p.label}</div>
              {p.description && (
                <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: 4 }}>{p.description}</div>
              )}
              <span className={`badge ${configured ? "ok" : ""}`} style={{ marginTop: 8, display: "inline-block" }}>
                {configured ? "Configured" : "Not configured"}
              </span>
            </div>
          );
        })}
      </div>

      {openProvider && (
        <Modal title={openProvider.label} onClose={() => setOpenKey(null)} maxWidth={520}>
          {openProvider.description && (
            <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>{openProvider.description}</p>
          )}
          {openProvider.fields.map((f) => (
            <div key={f.key}>
              <label>{f.label}</label>
              {f.type === "select" ? (
                <select
                  key={settings[f.key] ?? `${f.key}-empty`}
                  defaultValue={settings[f.key] ?? f.options?.[0]?.value ?? ""}
                  onChange={(e) => saveSetting(f.key, e.target.value)}
                >
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={f.type === "password" ? "password" : "text"}
                  key={settings[f.key] ?? `${f.key}-empty`}
                  defaultValue={settings[f.key] ?? ""}
                  placeholder={f.placeholder}
                  onBlur={(e) => saveSetting(f.key, e.target.value)}
                />
              )}
              {f.helpText && <p style={{ color: "var(--muted)", fontSize: "0.78rem", marginTop: 2 }}>{f.helpText}</p>}
            </div>
          ))}
        </Modal>
      )}
    </>
  );
}
