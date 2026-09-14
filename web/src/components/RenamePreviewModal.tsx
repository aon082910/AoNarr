import { useEffect, useState } from "react";
import Modal from "./Modal.js";
import { api } from "../api/client.js";

interface RenameResult {
  renamed: { title: string; from: string; to: string }[];
  errors: { title: string; error: string }[];
  skippedMusic: number;
}

/** Radarr-style rename preview — Organize & Rename used to be confirm() → execute → alert with a
 * summary after the fact; this shows the actual from/to path list first (fetched via `?preview=1`,
 * which computes the same paths without touching the filesystem/database) so an admin can see
 * exactly what's about to move before committing to it. */
export default function RenamePreviewModal({
  endpoint,
  itemLabel,
  onClose,
  onDone,
}: {
  endpoint: string;
  itemLabel: string;
  onClose: () => void;
  onDone: (result: RenameResult) => void;
}) {
  const [preview, setPreview] = useState<RenameResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    const sep = endpoint.includes("?") ? "&" : "?";
    api
      .post<RenameResult>(`${endpoint}${sep}preview=1`, {})
      .then(setPreview)
      .catch((e) => setError((e as Error).message));
  }, [endpoint]);

  async function apply() {
    setApplying(true);
    setError(null);
    try {
      const result = await api.post<RenameResult>(endpoint, {});
      onDone(result);
    } catch (e) {
      setError((e as Error).message);
      setApplying(false);
    }
  }

  return (
    <Modal title={`Rename preview — ${itemLabel}`} onClose={onClose} maxWidth={720}>
      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      {!preview && !error && <p className="empty">Computing...</p>}
      {preview && (
        <>
          {preview.renamed.length === 0 ? (
            <p className="empty">Already organized — nothing would move.</p>
          ) : (
            <>
              <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
                {preview.renamed.length} file(s) would move to match the current naming template:
              </p>
              <div style={{ maxHeight: "45vh", overflowY: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>From</th>
                      <th>To</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.renamed.map((r, idx) => (
                      <tr key={idx}>
                        <td style={{ wordBreak: "break-all", fontSize: "0.8rem" }}>{r.from}</td>
                        <td style={{ wordBreak: "break-all", fontSize: "0.8rem" }}>{r.to}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {preview.skippedMusic > 0 && (
            <p style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
              {preview.skippedMusic} music track(s) skipped — track filenames are never templated (see Naming settings).
            </p>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button type="button" onClick={apply} disabled={applying || preview.renamed.length === 0}>
              {applying ? "Renaming..." : `Rename ${preview.renamed.length} file(s)`}
            </button>
            <button type="button" className="secondary" onClick={onClose} disabled={applying}>
              Cancel
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
