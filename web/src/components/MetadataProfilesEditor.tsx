import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client.js";
import { confirmDialog } from "../utils/confirmDialog.js";
import { notify } from "../utils/notify.js";
import type { MetadataProfile } from "../types.js";

interface ReleaseTypes {
  primary: string[];
  secondary: string[];
}

const SECONDARY_LABELS: Record<string, string> = {
  live: "Live",
  compilation: "Compilation",
  soundtrack: "Soundtrack",
  spokenword: "Spoken word",
  interview: "Interview",
  audiobook: "Audiobook",
  "audio drama": "Audio drama",
  remix: "Remix",
  "dj-mix": "DJ-mix",
  "mixtape/street": "Mixtape/Street",
  demo: "Demo",
  "field recording": "Field recording",
};

function label(type: string): string {
  return SECONDARY_LABELS[type] ?? type.toUpperCase();
}

/**
 * Lidarr's and Readarr's metadata profile: which of an artist's releases, or an author's works, are listed
 * at all. A profile applies to the artists and authors that name it, to those added into a root folder
 * that names it, or to every one when it is made the default. With no profile at all the global
 * "Music Album Types" setting decides, as before profiles existed.
 */
export default function MetadataProfilesEditor() {
  const [profiles, setProfiles] = useState<MetadataProfile[]>([]);
  const [types, setTypes] = useState<ReleaseTypes>({ primary: [], secondary: [] });
  const [name, setName] = useState("");

  function load() {
    api.get<MetadataProfile[]>("/metadata-profiles").then(setProfiles).catch(() => undefined);
  }
  useEffect(() => {
    load();
    api.get<ReleaseTypes>("/metadata-profiles/types").then(setTypes).catch(() => undefined);
  }, []);

  async function save(profile: MetadataProfile, patch: Partial<MetadataProfile>) {
    try {
      await api.put(`/metadata-profiles/${profile.id}`, patch);
      load();
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  function toggle(list: string[], value: string): string[] {
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      // "Standard" in Lidarr: studio albums only.
      await api.post("/metadata-profiles", {
        name: name.trim(),
        primaryTypes: ["album"],
        excludedSecondaryTypes: ["live", "compilation", "soundtrack", "remix", "dj-mix", "demo", "spokenword", "interview", "audiobook", "audio drama", "mixtape/street", "field recording"],
      });
      setName("");
      load();
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  async function makeDefault(profile: MetadataProfile) {
    await api.post("/metadata-profiles/default", { id: profile.isDefault ? null : profile.id });
    load();
  }

  async function remove(profile: MetadataProfile) {
    if (!(await confirmDialog({ title: "Delete metadata profile", message: `Delete "${profile.name}"?`, danger: true }))) return;
    try {
      await api.del(`/metadata-profiles/${profile.id}`);
      load();
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  return (
    <div>
      <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
        A profile decides which releases an artist or author lists. For music, tick the release types to list and the
        extra types to leave out (a live album, a compilation). For books, skip works with no date and box sets. A new
        profile starts as studio albums only. It applies the next time the artist's or author's releases are fetched, not
        retroactively. With no profile, the global Music Album Types setting decides.
      </p>
      {profiles.length === 0 && <p className="empty">No metadata profiles yet.</p>}
      {profiles.map((p) => (
        <div key={p.id} className="form-panel" style={{ marginBottom: 12 }}>
          <strong>
            {p.name}
            {p.isDefault ? " (default)" : ""}
          </strong>
          <label>Release types listed</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            {types.primary.map((t) => (
              <label key={t} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <input type="checkbox" checked={p.primaryTypes.includes(t)} onChange={() => save(p, { primaryTypes: toggle(p.primaryTypes, t) })} />
                {label(t)}
              </label>
            ))}
          </div>
          <label>Left out when a release is also</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            {types.secondary.map((t) => (
              <label key={t} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <input type="checkbox" checked={p.excludedSecondaryTypes.includes(t)} onChange={() => save(p, { excludedSecondaryTypes: toggle(p.excludedSecondaryTypes, t) })} />
                {label(t)}
              </label>
            ))}
          </div>
          <label>Books</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <input type="checkbox" checked={p.skipMissingDate} onChange={(e) => save(p, { skipMissingDate: e.target.checked })} />
              Skip works with no date
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <input type="checkbox" checked={p.skipSets} onChange={(e) => save(p, { skipSets: e.target.checked })} />
              Skip box sets and omnibuses
            </label>
          </div>
          <div className="toolbar" style={{ gap: 8, marginTop: 8 }}>
            <button type="button" className="secondary" onClick={() => makeDefault(p)}>
              {p.isDefault ? "Clear as default" : "Make default"}
            </button>
            <button type="button" className="danger" onClick={() => remove(p)}>
              Delete
            </button>
          </div>
        </div>
      ))}
      <form className="toolbar" style={{ gap: 8 }} onSubmit={create}>
        <input aria-label="New metadata profile name" value={name} onChange={(e) => setName(e.target.value)} placeholder="New profile name" />
        <button type="submit" disabled={!name.trim()}>
          Add profile
        </button>
      </form>
    </div>
  );
}
