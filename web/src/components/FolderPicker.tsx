import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import Modal from "./Modal.js";

interface BrowseResponse {
  path: string;
  parent: string | null;
  directories: string[];
}

/** A folder browser modal — the same "Browse for folder" pattern every *Starr app offers instead
 * of typing/pasting a path blind. Scoped to whatever the container can see (its mounted volumes),
 * so it's really just a picker over the same filesystem a path input already assumes. */
export default function FolderPicker({
  initialPath,
  onSelect,
  onClose,
}: {
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  function browse(path: string) {
    setError(null);
    api
      .get<BrowseResponse>(`/system/browse-directory?path=${encodeURIComponent(path)}`)
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }

  useEffect(() => {
    browse(initialPath || "/");
  }, [initialPath]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data && !error) return null;

  return (
    <Modal title="Browse for folder" onClose={onClose} maxWidth={520}>
      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      {data && (
        <>
          <p style={{ fontFamily: "monospace", wordBreak: "break-all" }}>{data.path}</p>
          <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
            {data.parent && (
              <div
                onClick={() => browse(data.parent!)}
                style={{ padding: "6px 10px", cursor: "pointer", borderBottom: "1px solid var(--border)" }}
              >
                .. (up)
              </div>
            )}
            {data.directories.length === 0 && !data.parent && (
              <div style={{ padding: "6px 10px", color: "var(--muted)" }}>No subfolders</div>
            )}
            {data.directories.map((dir) => {
              const child = data.path.endsWith("/") ? `${data.path}${dir}` : `${data.path}/${dir}`;
              return (
                <div
                  key={dir}
                  onClick={() => browse(child)}
                  style={{ padding: "6px 10px", cursor: "pointer", borderBottom: "1px solid var(--border)" }}
                >
                  📁 {dir}
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button type="button" onClick={() => onSelect(data.path)}>
              Select this folder
            </button>
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
