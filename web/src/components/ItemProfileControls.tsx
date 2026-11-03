import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { notify } from "../utils/notify.js";
import type { MediaItem, MetadataProfile } from "../types.js";

/**
 * The two choices a title keeps for its future: whether the episodes, albums or books a refresh finds later are
 * monitored, and (for an artist or author) which metadata profile decides what is listed. Each saves at once, like
 * the other selects in the edit dialog.
 */
export default function ItemProfileControls({
  item,
  shape,
  onChange,
}: {
  item: MediaItem;
  shape: string;
  onChange: (updated: Pick<MediaItem, "monitorNewItems" | "metadataProfileId">) => void;
}) {
  const [profiles, setProfiles] = useState<MetadataProfile[]>([]);
  const listsReleases = item.type === "artist" || item.type === "author";

  useEffect(() => {
    if (listsReleases) api.get<MetadataProfile[]>("/metadata-profiles").then(setProfiles).catch(() => undefined);
  }, [listsReleases]);

  async function save(patch: { monitorNewItems?: string | null; metadataProfileId?: number | null }) {
    try {
      const updated = await api.patch<MediaItem>(`/media/${item.id}`, patch);
      onChange({ monitorNewItems: updated.monitorNewItems ?? null, metadataProfileId: updated.metadataProfileId ?? null });
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  if (shape !== "episodic" && shape !== "collection") return null;
  return (
    <>
      <label htmlFor="mediadetail-monitor-new-items">Monitor new items</label>
      <select
        id="mediadetail-monitor-new-items"
        value={item.monitorNewItems ?? ""}
        onChange={(e) => save({ monitorNewItems: e.target.value || null })}
        title="What a refresh does with an episode, album or book the provider lists after the first sync"
      >
        <option value="">Not set — the earlier behavior</option>
        <option value="all">Monitor all new items</option>
        <option value="new">Only items newer than what exists</option>
        <option value="none">Do not monitor new items</option>
      </select>
      {listsReleases && (
        <>
          <label htmlFor="mediadetail-metadata-profile">Metadata profile</label>
          <select
            id="mediadetail-metadata-profile"
            value={item.metadataProfileId ?? ""}
            onChange={(e) => save({ metadataProfileId: e.target.value ? Number(e.target.value) : null })}
            title="Which of the provider's releases are listed. Applies the next time they are fetched."
          >
            <option value="">Root folder or instance default</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </>
      )}
    </>
  );
}
