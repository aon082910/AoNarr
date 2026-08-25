import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import type { LibraryGroup } from "../types.js";

export const GROUP_KIND_LABEL: Record<string, string> = {
  system: "System",
  maker: "Maker",
  site: "Site",
  creator: "Creator",
  series: "Series",
};
const NEW_VALUE = "__new__";

/** Cascading level pickers for a grouped library type (ROMs/Adult/Online Videos/Courses) — one
 * select per groupLevels entry, each scoped to the previous level's choice, with a "+ New" option
 * at every level. Reports the deepest fully-selected group's id (or null) via onChange. Pass
 * `initialChain` (group ids root-first) to preselect an existing item's current location. */
export default function GroupPicker({
  type,
  groupLevels,
  initialChain,
  onChange,
}: {
  type: string;
  groupLevels: string[];
  initialChain?: (number | null)[];
  onChange: (groupId: number | null) => void;
}) {
  const [chain, setChain] = useState<(number | null)[]>(initialChain ?? groupLevels.map(() => null));
  const [optionsAtLevel, setOptionsAtLevel] = useState<LibraryGroup[][]>(groupLevels.map(() => []));

  useEffect(() => {
    if (groupLevels.length === 0) return;
    api.get<LibraryGroup[]>(`/library-groups?mediaType=${type}`).then((rows) =>
      setOptionsAtLevel((prev) => {
        const next = [rows, ...prev.slice(1)];
        return next;
      })
    );
    // Fetch options for every preselected level so the dropdowns show the current chain, not just level 0.
    (initialChain ?? []).forEach((groupId, idx) => {
      if (groupId && idx + 1 < groupLevels.length) {
        api.get<LibraryGroup[]>(`/library-groups?mediaType=${type}&parentId=${groupId}`).then((rows) =>
          setOptionsAtLevel((prev) => {
            const next = [...prev];
            next[idx + 1] = rows;
            return next;
          })
        );
      }
    });
  }, [type, groupLevels.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const deepest = chain.length > 0 && chain.every((v) => v !== null) ? chain[chain.length - 1] : null;
    onChange(deepest);
  }, [chain]); // eslint-disable-line react-hooks/exhaustive-deps

  async function selectAt(levelIdx: number, value: string) {
    if (value === NEW_VALUE) {
      const kind = groupLevels[levelIdx];
      const name = prompt(`New ${GROUP_KIND_LABEL[kind] ?? kind}:`);
      if (!name?.trim()) return;
      // A "site" group's tile shows a logo — asking for the site's own URL here lets the server
      // fetch its favicon (the icon the site itself exposes for external identification, same as
      // a browser tab) rather than leaving the tile with no artwork until someone sets it by hand.
      const website = kind === "site" ? prompt(`${name.trim()}'s website (optional, used to fetch a logo):`) : null;
      const parentGroupId = levelIdx === 0 ? null : chain[levelIdx - 1];
      const created = await api.post<LibraryGroup>("/library-groups", {
        mediaType: type,
        kind,
        name: name.trim(),
        parentGroupId,
        website: website?.trim() || undefined,
      });
      setOptionsAtLevel((prev) => {
        const next = [...prev];
        next[levelIdx] = [...next[levelIdx], created];
        return next;
      });
      applySelection(levelIdx, created.id);
      return;
    }
    applySelection(levelIdx, value ? Number(value) : null);
  }

  function applySelection(levelIdx: number, groupId: number | null) {
    setChain((prev) => {
      const next = [...prev];
      next[levelIdx] = groupId;
      for (let i = levelIdx + 1; i < next.length; i++) next[i] = null;
      return next;
    });
    if (groupId && levelIdx + 1 < groupLevels.length) {
      api.get<LibraryGroup[]>(`/library-groups?mediaType=${type}&parentId=${groupId}`).then((rows) =>
        setOptionsAtLevel((prev) => {
          const next = [...prev];
          next[levelIdx + 1] = rows;
          for (let i = levelIdx + 2; i < next.length; i++) next[i] = [];
          return next;
        })
      );
    } else {
      setOptionsAtLevel((prev) => {
        const next = [...prev];
        for (let i = levelIdx + 1; i < next.length; i++) next[i] = [];
        return next;
      });
    }
  }

  if (groupLevels.length === 0) return null;

  return (
    <>
      {groupLevels.map((kind, idx) => {
        const disabled = idx > 0 && chain[idx - 1] === null;
        return (
          <div key={kind}>
            <label>{GROUP_KIND_LABEL[kind] ?? kind}</label>
            <select value={chain[idx] ?? ""} disabled={disabled} onChange={(e) => selectAt(idx, e.target.value)}>
              <option value="">
                {disabled ? `Select a ${GROUP_KIND_LABEL[groupLevels[idx - 1]]} first` : `Select ${GROUP_KIND_LABEL[kind]}...`}
              </option>
              {optionsAtLevel[idx]?.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
              <option value={NEW_VALUE}>+ New {GROUP_KIND_LABEL[kind] ?? kind}...</option>
            </select>
          </div>
        );
      })}
    </>
  );
}
