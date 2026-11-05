import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api } from "../api/client.js";
import Modal from "./Modal.js";
import { PencilIcon, TrashIcon, XIcon } from "./ActionIcons.js";
import { confirmDialog } from "../utils/confirmDialog.js";
import { notify } from "../utils/notify.js";
import { useBackgroundJobs } from "../context/BackgroundJobsContext.js";
import type { Tag } from "../types.js";

interface ApplySummary {
  startedAt: string;
  finishedAt: string | null;
  total: number;
  scanned: number;
  matching: number;
  itemsGaining: number;
  itemsLosing: number;
  tagsAdded: number;
  tagsRemoved: number;
  cancelled: boolean;
  error: string | null;
}

interface Rule {
  id: number;
  name: string;
  enabled: boolean;
  match: "any" | "all";
  libraryTypes: string[];
  genres: string[];
  listIds: number[];
  tagIds: number[];
  removeWhenUnmatched: boolean;
  /** How the last run of Apply since the server started went; null when there was none. */
  lastApply: ApplySummary | null;
}

interface Meta {
  libraryTypes: { key: string; label: string }[];
  genres: string[];
  lists: { id: number; name: string; type: string }[];
}

interface Preview {
  scanned: number;
  matching: number;
  itemsGaining: number;
  itemsLosing: number;
  tagsAdded: number;
  tagsRemoved: number;
  samples: { id: number; title: string; year: number | null; type: string; adds: string[]; removes: string[] }[];
}

/**
 * Auto tagging (Sonarr's and Radarr's "Auto Tagging"): a rule gives the titles that meet its conditions (library type,
 * genre, import list) its tags. It runs when a title is added, after a metadata refresh and after an import list sync;
 * "Apply to library" runs it over the titles already there. With "Remove tags automatically" a rule also takes back the
 * tags it gave once a title stops matching, but never a tag you set by hand.
 */
export default function AutoTagRules({ tags }: { tags: Tag[] }) {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [editor, setEditor] = useState<{ existing: Rule | null } | null>(null);
  const [previews, setPreviews] = useState<Record<number, Preview | "loading">>({});
  const { jobs, startJob } = useBackgroundJobs();

  const load = useCallback(() => {
    api
      .get<Rule[]>("/auto-tag-rules")
      .then(setRules)
      .catch((e) => notify.error((e as Error).message));
    api
      .get<Meta>("/auto-tag-rules/meta")
      .then(setMeta)
      .catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  // The counts of a run are on the rule once it ends, so the list is read again when the last running one finishes.
  const runningKey = jobs
    .filter((j) => j.kind === "autoTag" && j.running)
    .map((j) => j.id)
    .join(",");
  const wasRunning = useRef("");
  useEffect(() => {
    if (wasRunning.current && !runningKey) load();
    wasRunning.current = runningKey;
  }, [runningKey, load]);

  const tagName = (id: number) => tags.find((t) => t.id === id)?.name ?? `#${id}`;
  const typeLabel = (key: string) => meta?.libraryTypes.find((t) => t.key === key)?.label ?? key;
  const listName = (id: number) => meta?.lists.find((l) => l.id === id)?.name ?? `list #${id} (deleted)`;

  function conditions(rule: Rule): string {
    const parts: string[] = [];
    if (rule.libraryTypes.length > 0) parts.push(`library is ${rule.libraryTypes.map(typeLabel).join(" or ")}`);
    if (rule.genres.length > 0) parts.push(`genre is ${rule.genres.join(" or ")}`);
    if (rule.listIds.length > 0) parts.push(`on the list ${rule.listIds.map(listName).join(" or ")}`);
    return parts.join(rule.match === "all" ? " and " : " or ");
  }

  async function setEnabled(rule: Rule, enabled: boolean) {
    try {
      await api.put(`/auto-tag-rules/${rule.id}`, { enabled });
      load();
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  async function remove(rule: Rule) {
    const ok = await confirmDialog({
      title: "Delete auto tagging rule",
      message: `Delete "${rule.name}"? The tags it already put on titles stay on them as ordinary tags.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/auto-tag-rules/${rule.id}`);
      load();
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  async function preview(rule: Rule) {
    setPreviews((prev) => ({ ...prev, [rule.id]: "loading" }));
    try {
      const result = await api.post<Preview>(`/auto-tag-rules/${rule.id}/preview`);
      setPreviews((prev) => ({ ...prev, [rule.id]: result }));
    } catch (e) {
      setPreviews((prev) => {
        const { [rule.id]: _gone, ...rest } = prev;
        return rest;
      });
      notify.error((e as Error).message);
    }
  }

  async function apply(rule: Rule) {
    const ok = await confirmDialog({
      title: "Apply to library",
      message: `Run "${rule.name}" over every title in the library now? Titles that match get ${rule.tagIds.map(tagName).join(", ")}${
        rule.removeWhenUnmatched ? ", and titles that no longer match lose the tags this rule gave them" : ""
      }. Use Preview first to see what would change.`,
      confirmLabel: "Apply",
    });
    if (!ok) return;
    try {
      await startJob("autoTag", `rule-${rule.id}`, `Auto tagging: ${rule.name}`, `/auto-tag-rules/${rule.id}/apply`);
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  if (!rules) return <p style={{ color: "var(--muted)" }}>Loading...</p>;

  return (
    <>
      <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
        A rule gives its tags to every title that meets its conditions: when the title is added, after its metadata is refreshed and after an import list
        syncs. Conditions: the library, the genre and the import list. Tags you set by hand are never taken over or removed.
      </p>
      <div className="toolbar" style={{ marginBottom: 8 }}>
        <button type="button" onClick={() => setEditor({ existing: null })} disabled={tags.length === 0} title={tags.length === 0 ? "Add a tag first" : undefined}>
          + Add rule
        </button>
      </div>
      {tags.length === 0 && <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>Add a tag above first: a rule needs a tag to give.</p>}

      {rules.length === 0 ? (
        <p className="empty">No auto tagging rules yet.</p>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {rules.map((rule) => {
            const running = jobs.some((j) => j.kind === "autoTag" && j.type === `rule-${rule.id}` && j.running);
            const shown = previews[rule.id];
            const last = rule.lastApply;
            return (
              <div key={rule.id} className="card" style={{ padding: 14, opacity: rule.enabled ? 1 : 0.65 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{rule.name}</span>
                  {!rule.enabled && <span className="badge danger">Off</span>}
                  {rule.removeWhenUnmatched && <span className="badge">Removes tags</span>}
                </div>
                <div style={{ fontSize: "0.82rem", color: "var(--muted)", marginTop: 6, overflowWrap: "anywhere" }}>
                  When {conditions(rule) || "(no condition)"}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6, alignItems: "center", fontSize: "0.82rem" }}>
                  <span style={{ color: "var(--muted)" }}>Gives:</span>
                  {rule.tagIds.map((id) => (
                    <span key={id} className="badge">
                      {tagName(id)}
                    </span>
                  ))}
                </div>
                <label htmlFor={`auto-tag-enabled-${rule.id}`} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: "0.85rem" }}>
                  <input
                    id={`auto-tag-enabled-${rule.id}`}
                    type="checkbox"
                    style={{ width: "auto" }}
                    checked={rule.enabled}
                    onChange={(e) => setEnabled(rule, e.target.checked)}
                  />
                  Enabled
                </label>
                <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                  <button type="button" className="secondary" disabled={shown === "loading"} onClick={() => preview(rule)}>
                    {shown === "loading" ? "Counting..." : "Preview"}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={!rule.enabled || running}
                    title={rule.enabled ? undefined : "Switch the rule on first"}
                    onClick={() => apply(rule)}
                  >
                    {running ? "Applying..." : "Apply to library"}
                  </button>
                  <button type="button" className="secondary" aria-label={`Edit ${rule.name}`} onClick={() => setEditor({ existing: rule })}>
                    <PencilIcon /> Edit
                  </button>
                  <button type="button" className="secondary" aria-label={`Delete ${rule.name}`} onClick={() => remove(rule)}>
                    <TrashIcon /> Delete
                  </button>
                </div>

                {shown && shown !== "loading" && (
                  <div role="status" style={{ marginTop: 10, fontSize: "0.82rem" }}>
                    <div>
                      {shown.matching} of {shown.scanned} title{shown.scanned === 1 ? "" : "s"} match.{" "}
                      {shown.itemsGaining === 0 && shown.itemsLosing === 0
                        ? "Nothing would change."
                        : [
                            shown.itemsGaining > 0 ? `${shown.itemsGaining} would get tags (${shown.tagsAdded} in all)` : "",
                            shown.itemsLosing > 0 ? `${shown.itemsLosing} would lose tags (${shown.tagsRemoved} in all)` : "",
                          ]
                            .filter(Boolean)
                            .join("; ") + "."}
                    </div>
                    {shown.samples.length > 0 && (
                      <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: "var(--muted)" }}>
                        {shown.samples.map((s) => (
                          <li key={s.id} style={{ overflowWrap: "anywhere" }}>
                            {s.title}
                            {s.year ? ` (${s.year})` : ""}
                            {s.adds.length > 0 ? ` + ${s.adds.join(", ")}` : ""}
                            {s.removes.length > 0 ? ` - ${s.removes.join(", ")}` : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {last && last.finishedAt && (
                  <div style={{ marginTop: 8, fontSize: "0.78rem", color: last.error ? "var(--danger)" : "var(--muted)" }}>
                    {last.error
                      ? `Last apply failed: ${last.error}`
                      : `Last apply: ${last.scanned} title${last.scanned === 1 ? "" : "s"} checked, ${last.tagsAdded} tag${last.tagsAdded === 1 ? "" : "s"} added, ${last.tagsRemoved} removed${
                          last.cancelled ? " (cancelled)" : ""
                        }.`}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editor && (
        <RuleForm
          existing={editor.existing}
          meta={meta}
          tags={tags}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            load();
          }}
        />
      )}
    </>
  );
}

/** The add / edit form of one rule. */
function RuleForm({
  existing,
  meta,
  tags,
  onClose,
  onSaved,
}: {
  existing: Rule | null;
  meta: Meta | null;
  tags: Tag[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [match, setMatch] = useState<"any" | "all">(existing?.match ?? "any");
  const [libraryTypes, setLibraryTypes] = useState<string[]>(existing?.libraryTypes ?? []);
  const [genres, setGenres] = useState<string[]>(existing?.genres ?? []);
  const [genreDraft, setGenreDraft] = useState("");
  // A list deleted since is not offered, so saving drops it from the rule.
  const [listIds, setListIds] = useState<number[]>((existing?.listIds ?? []).filter((id) => !meta || meta.lists.some((l) => l.id === id)));
  const [tagIds, setTagIds] = useState<number[]>(existing?.tagIds ?? []);
  const [removeWhenUnmatched, setRemoveWhenUnmatched] = useState(existing?.removeWhenUnmatched ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = (suffix: string) => `auto-tag-form-${existing?.id ?? "new"}-${suffix}`;

  const toggle = <T,>(list: T[], value: T, on: boolean): T[] => (on ? [...list, value] : list.filter((v) => v !== value));

  /** Adds the genres typed (comma separated), without repeating one already there in another case. */
  function addGenres(raw: string) {
    const next = [...genres];
    for (const part of raw.split(",")) {
      const genre = part.trim();
      if (genre && !next.some((g) => g.toLowerCase() === genre.toLowerCase())) next.push(genre);
    }
    setGenres(next);
    setGenreDraft("");
  }

  function genreKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addGenres(genreDraft);
    } else if (e.key === "Backspace" && !genreDraft && genres.length > 0) {
      setGenres(genres.slice(0, -1));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    // A genre still being typed counts.
    const allGenres = genreDraft.trim() ? [...genres, ...genreDraft.split(",").map((g) => g.trim()).filter(Boolean)] : genres;
    if (libraryTypes.length === 0 && allGenres.length === 0 && listIds.length === 0) {
      setError("Pick at least one condition: a library, a genre or an import list.");
      return;
    }
    if (tagIds.length === 0) {
      setError("Pick at least one tag to give.");
      return;
    }
    setSaving(true);
    try {
      const body = { name, enabled, match, libraryTypes, genres: allGenres, listIds, tagIds, removeWhenUnmatched };
      if (existing) await api.put(`/auto-tag-rules/${existing.id}`, body);
      else await api.post("/auto-tag-rules", body);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const legend = { fontSize: "0.85rem", color: "var(--muted)" } as const;
  const group = { border: "none", padding: 0, margin: "10px 0 0" } as const;
  const row = { display: "flex", flexWrap: "wrap", gap: "4px 14px" } as const;
  const check = { display: "flex", alignItems: "center", gap: 4, fontSize: "0.85rem", margin: 0 } as const;

  return (
    <Modal title={existing ? `Edit rule - ${existing.name}` : "Add auto tagging rule"} onClose={onClose} maxWidth={600}>
      <form className="form-panel" onSubmit={submit} style={{ padding: 0 }}>
        <label htmlFor={id("name")}>Name</label>
        <input id={id("name")} value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />

        <fieldset style={group}>
          <legend style={legend}>Library (a title in any of these)</legend>
          <div style={row}>
            {(meta?.libraryTypes ?? []).map((t) => (
              <label key={t.key} style={check}>
                <input type="checkbox" style={{ width: "auto" }} checked={libraryTypes.includes(t.key)} onChange={(e) => setLibraryTypes(toggle(libraryTypes, t.key, e.target.checked))} />
                {t.label}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset style={group}>
          <legend style={legend}>Genre (a title with any of these; type a name and press Enter)</legend>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
            {genres.map((g) => (
              <span key={g} className="badge" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                {g}
                <button type="button" className="icon-button" aria-label={`Remove genre ${g}`} onClick={() => setGenres(genres.filter((x) => x !== g))}>
                  <XIcon />
                </button>
              </span>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              id={id("genre")}
              aria-label="Add a genre"
              list={id("genre-list")}
              value={genreDraft}
              placeholder="Genre, for example Anime"
              onChange={(e) => setGenreDraft(e.target.value)}
              onKeyDown={genreKey}
              onBlur={() => genreDraft.trim() && addGenres(genreDraft)}
              style={{ flex: 1, minWidth: 0 }}
            />
            <button type="button" className="secondary" onClick={() => addGenres(genreDraft)}>
              Add
            </button>
          </div>
          <datalist id={id("genre-list")}>
            {(meta?.genres ?? []).map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
          <p style={{ color: "var(--muted)", fontSize: "0.78rem", margin: "4px 0 0" }}>Genres are compared without regard to case. The suggestions are the genres in your library.</p>
        </fieldset>

        <fieldset style={group}>
          <legend style={legend}>Import list (a title that a list added or holds)</legend>
          {(meta?.lists ?? []).length === 0 ? (
            <p style={{ color: "var(--muted)", fontSize: "0.8rem", margin: 0 }}>No import lists yet.</p>
          ) : (
            <div style={row}>
              {meta!.lists.map((l) => (
                <label key={l.id} style={check}>
                  <input type="checkbox" style={{ width: "auto" }} checked={listIds.includes(l.id)} onChange={(e) => setListIds(toggle(listIds, l.id, e.target.checked))} />
                  {l.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <label htmlFor={id("match")} style={{ marginTop: 10 }}>
          A title gets the tags when
        </label>
        <select id={id("match")} value={match} onChange={(e) => setMatch(e.target.value as "any" | "all")}>
          <option value="any">any one of the conditions above holds</option>
          <option value="all">every kind of condition above that has a value holds</option>
        </select>

        <fieldset style={group}>
          <legend style={legend}>Tags to give</legend>
          <div style={row}>
            {tags.map((t) => (
              <label key={t.id} style={check}>
                <input type="checkbox" style={{ width: "auto" }} checked={tagIds.includes(t.id)} onChange={(e) => setTagIds(toggle(tagIds, t.id, e.target.checked))} />
                {t.name}
              </label>
            ))}
          </div>
        </fieldset>

        <label htmlFor={id("remove")} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
          <input id={id("remove")} type="checkbox" style={{ width: "auto" }} checked={removeWhenUnmatched} onChange={(e) => setRemoveWhenUnmatched(e.target.checked)} />
          Remove tags automatically
        </label>
        <p style={{ color: "var(--muted)", fontSize: "0.78rem", margin: "2px 0 0" }}>
          Takes a tag this rule gave off a title again when the title stops matching. A tag you set by hand is never removed.
        </p>

        <label htmlFor={id("enabled")} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
          <input id={id("enabled")} type="checkbox" style={{ width: "auto" }} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>

        {error && (
          <p role="alert" style={{ color: "var(--danger)", fontSize: "0.85rem", overflowWrap: "anywhere" }}>
            {error}
          </p>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button type="submit" disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </button>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
