import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client.js";
import Modal from "./Modal.js";
import { PencilIcon, TrashIcon } from "./ActionIcons.js";
import { confirmDialog } from "../utils/confirmDialog.js";
import { notify } from "../utils/notify.js";
import type { Tag } from "../types.js";

/** What a secret that is set shows as; sent back unchanged on an edit, it keeps the stored value. */
const SECRET_MASK = "********";

interface FieldDef {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "boolean" | "select" | "headers";
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  default?: string | number | boolean;
}

interface KindDef {
  kind: string;
  label: string;
  description?: string;
  fields: FieldDef[];
}

interface TemplateDef {
  event: string;
  label: string;
  key: string;
  default: string;
  tokens: string[];
}

interface Meta {
  kinds: KindDef[];
  events: { key: string; optIn: boolean }[];
  templates: TemplateDef[];
}

interface Connection {
  id: number;
  name: string;
  kind: string;
  kindLabel: string;
  config: Record<string, any>;
  /** The saved list, null when it was never saved (the defaults apply). */
  events: string[] | null;
  effectiveEvents: string[];
  tagIds: number[];
  enabled: boolean;
}

interface HeaderRow {
  name: string;
  value: string;
}

type Editor = { step: "pick" } | { step: "form"; kind: KindDef; existing: Connection | null };

function useMeta() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<Meta>("/notifications/connections/meta")
      .then(setMeta)
      .catch((e) => setError((e as Error).message));
  }, []);
  return { meta, error };
}

/**
 * Notification connections (Sonarr/Radarr's Settings > Connect): any number of named destinations, each of one kind,
 * each with its own events and tags. Two Discord channels can get different events. Secrets are never sent to the page:
 * a field that is set shows as ******** and keeps its stored value unless it is retyped.
 */
export default function NotificationConnections() {
  const { meta, error: metaError } = useMeta();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [testing, setTesting] = useState<number | null>(null);
  const [results, setResults] = useState<Record<number, { ok: boolean; error?: string }>>({});

  const load = useCallback(() => {
    api
      .get<Connection[]>("/notifications/connections")
      .then(setConnections)
      .catch((e) => notify.error((e as Error).message));
  }, []);
  useEffect(() => {
    load();
    api.get<Tag[]>("/tags").then(setTags).catch(() => undefined);
  }, [load]);

  async function test(conn: Connection) {
    setTesting(conn.id);
    try {
      const result = await api.post<{ ok: boolean; error?: string }>(`/notifications/connections/${conn.id}/test`, {});
      setResults((prev) => ({ ...prev, [conn.id]: result }));
    } catch (e) {
      setResults((prev) => ({ ...prev, [conn.id]: { ok: false, error: (e as Error).message } }));
    } finally {
      setTesting(null);
    }
  }

  async function setEnabled(conn: Connection, enabled: boolean) {
    try {
      await api.put(`/notifications/connections/${conn.id}`, { enabled });
      load();
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  async function remove(conn: Connection) {
    const ok = await confirmDialog({ title: "Delete connection", message: `Delete "${conn.name}"? It stops receiving notifications.`, confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      await api.del(`/notifications/connections/${conn.id}`);
      load();
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  if (metaError) return <p style={{ color: "var(--danger)" }}>{metaError}</p>;
  if (!meta || !connections) return <p style={{ color: "var(--muted)" }}>Loading...</p>;

  const labelOf = (event: string) => meta.templates.find((t) => t.event === event)?.label ?? event;
  const kindOf = (kind: string) => meta.kinds.find((k) => k.kind === kind);
  const tagName = (id: number) => tags.find((t) => t.id === id)?.name ?? `#${id}`;

  return (
    <>
      <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>
        A connection is one place AoNarr sends its notifications: a Discord channel, a webhook, an email address. Add as many as you like, each with its own events
        and, if you want, tags (it then hears only of titles that carry one of them).
      </p>
      <div className="toolbar" style={{ marginBottom: 8 }}>
        <button type="button" onClick={() => setEditor({ step: "pick" })}>
          + Add connection
        </button>
      </div>

      {connections.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>No connections yet. Nothing is sent anywhere until you add one.</p>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))" }}>
          {connections.map((conn) => {
            const result = results[conn.id];
            const kind = kindOf(conn.kind);
            return (
              <div key={conn.id} className="card" style={{ padding: 16, opacity: conn.enabled ? 1 : 0.65 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{conn.name}</span>
                  <span className="badge">{kind?.label ?? conn.kindLabel}</span>
                  {!conn.enabled && <span className="badge danger">Off</span>}
                </div>
                <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: 6 }}>
                  {conn.effectiveEvents.length === 0 ? "No events" : conn.effectiveEvents.map(labelOf).join(", ")}
                </div>
                {conn.tagIds.length > 0 && (
                  <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: 4 }}>Only titles tagged: {conn.tagIds.map(tagName).join(", ")}</div>
                )}
                <label htmlFor={`notify-conn-enabled-${conn.id}`} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: "0.85rem" }}>
                  <input
                    id={`notify-conn-enabled-${conn.id}`}
                    type="checkbox"
                    style={{ width: "auto" }}
                    checked={conn.enabled}
                    onChange={(e) => setEnabled(conn, e.target.checked)}
                  />
                  Enabled
                </label>
                <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                  <button type="button" className="secondary" disabled={testing === conn.id} onClick={() => test(conn)}>
                    {testing === conn.id ? "Sending..." : "Test"}
                  </button>
                  <button type="button" className="secondary" aria-label={`Edit ${conn.name}`} onClick={() => kind && setEditor({ step: "form", kind, existing: conn })}>
                    <PencilIcon /> Edit
                  </button>
                  <button type="button" className="secondary" aria-label={`Delete ${conn.name}`} onClick={() => remove(conn)}>
                    <TrashIcon /> Delete
                  </button>
                </div>
                {result && (
                  <p role="status" style={{ color: result.ok ? "var(--ok)" : "var(--danger)", fontSize: "0.82rem", margin: "8px 0 0", overflowWrap: "anywhere" }}>
                    {result.ok ? "Sent. Check that connection for the test message." : result.error}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editor?.step === "pick" && (
        <Modal title="Add connection" onClose={() => setEditor(null)} maxWidth={560}>
          <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>What do you want to send notifications to?</p>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 150px), 1fr))" }}>
            {meta.kinds.map((k) => (
              <button key={k.kind} type="button" className="secondary" style={{ textAlign: "left", padding: 12 }} onClick={() => setEditor({ step: "form", kind: k, existing: null })}>
                <div style={{ fontWeight: 600 }}>{k.label}</div>
                {k.description && <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: 2 }}>{k.description}</div>}
              </button>
            ))}
          </div>
        </Modal>
      )}

      {editor?.step === "form" && (
        <ConnectionForm
          meta={meta}
          tags={tags}
          kind={editor.kind}
          existing={editor.existing}
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

/** The add / edit form of one connection: its name, the fields of its kind, its events and its tags. */
function ConnectionForm({
  meta,
  tags,
  kind,
  existing,
  onClose,
  onSaved,
}: {
  meta: Meta;
  tags: Tag[];
  kind: KindDef;
  existing: Connection | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? kind.label);
  const [config, setConfig] = useState<Record<string, any>>(() => {
    const initial: Record<string, any> = {};
    for (const f of kind.fields) {
      const stored = existing?.config[f.key];
      initial[f.key] = stored !== undefined ? stored : f.type === "headers" ? [] : f.default ?? (f.type === "boolean" ? false : "");
    }
    return initial;
  });
  // A new connection starts with the events a connection gets by default ticked; an existing one with what it sends.
  const [events, setEvents] = useState<string[]>(() => existing?.effectiveEvents ?? meta.events.filter((e) => !e.optIn).map((e) => e.key));
  const [eventsTouched, setEventsTouched] = useState(false);
  const [tagIds, setTagIds] = useState<number[]>(existing?.tagIds ?? []);
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setField = (key: string, value: unknown) => setConfig((prev) => ({ ...prev, [key]: value }));
  const labelOf = (event: string) => meta.templates.find((t) => t.event === event)?.label ?? event;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { name, config, tagIds, enabled };
      if (!existing || eventsTouched) body.events = events;
      if (existing) await api.put(`/notifications/connections/${existing.id}`, body);
      else await api.post("/notifications/connections", { ...body, kind: kind.kind });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const id = (suffix: string) => `notify-form-${existing?.id ?? "new"}-${suffix}`;

  return (
    <Modal title={existing ? `Edit connection - ${existing.name}` : `Add ${kind.label} connection`} onClose={onClose} maxWidth={560}>
      <form className="form-panel" onSubmit={submit} style={{ padding: 0 }}>
        {kind.description && <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 0 }}>{kind.description}</p>}
        <label htmlFor={id("name")}>Name</label>
        <input id={id("name")} value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />

        {kind.fields.map((f) => (
          <div key={f.key}>
            {f.type === "boolean" ? (
              <label htmlFor={id(f.key)} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input id={id(f.key)} type="checkbox" style={{ width: "auto" }} checked={!!config[f.key]} onChange={(e) => setField(f.key, e.target.checked)} />
                {f.label}
              </label>
            ) : (
              <>
                <label htmlFor={id(f.key)}>{f.label}</label>
                {f.type === "select" ? (
                  <select id={id(f.key)} value={String(config[f.key] ?? "")} onChange={(e) => setField(f.key, e.target.value)}>
                    {f.options?.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : f.type === "headers" ? (
                  <HeadersEditor idBase={id(f.key)} rows={config[f.key] as HeaderRow[]} onChange={(rows) => setField(f.key, rows)} />
                ) : (
                  <input
                    id={id(f.key)}
                    type={f.type === "password" ? "password" : f.type === "number" ? "number" : "text"}
                    value={String(config[f.key] ?? "")}
                    placeholder={f.placeholder}
                    required={f.required}
                    autoComplete="off"
                    // A secret that is set shows as the mask: selecting it all makes retyping replace it.
                    onFocus={(e) => config[f.key] === SECRET_MASK && e.currentTarget.select()}
                    onChange={(e) => setField(f.key, e.target.value)}
                  />
                )}
              </>
            )}
            {f.help && <p style={{ color: "var(--muted)", fontSize: "0.78rem", marginTop: 2 }}>{f.help}</p>}
          </div>
        ))}

        <fieldset style={{ border: "none", padding: 0, margin: "10px 0 0" }}>
          <legend style={{ fontSize: "0.85rem", color: "var(--muted)" }}>Send on</legend>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px" }}>
            {meta.events.map((ev) => (
              <label key={ev.key} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "0.85rem", margin: 0 }}>
                <input
                  type="checkbox"
                  style={{ width: "auto" }}
                  checked={events.includes(ev.key)}
                  onChange={(e) => {
                    setEventsTouched(true);
                    setEvents((prev) => (e.target.checked ? [...prev, ev.key] : prev.filter((k) => k !== ev.key)));
                  }}
                />
                {labelOf(ev.key)}
                {ev.optIn && <span style={{ color: "var(--muted)", fontSize: "0.72rem" }}>(off by default)</span>}
              </label>
            ))}
          </div>
          <p style={{ color: "var(--muted)", fontSize: "0.78rem", marginTop: 4 }}>
            The ones marked "off by default" arrive in bulk (a list adds a hundred titles at once), so a connection gets them only when ticked.
          </p>
        </fieldset>

        {tags.length > 0 && (
          <fieldset style={{ border: "none", padding: 0, margin: "8px 0" }}>
            <legend style={{ fontSize: "0.85rem", color: "var(--muted)" }}>Only for titles with these tags (none ticked: every title)</legend>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px" }}>
              {tags.map((tag) => (
                <label key={tag.id} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "0.85rem", margin: 0 }}>
                  <input
                    type="checkbox"
                    style={{ width: "auto" }}
                    checked={tagIds.includes(tag.id)}
                    onChange={(e) => setTagIds((prev) => (e.target.checked ? [...prev, tag.id] : prev.filter((t) => t !== tag.id)))}
                  />
                  {tag.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <label htmlFor={id("enabled")} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
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

/** The extra request headers of a webhook. A value that is set shows as ******** and keeps its stored value unless retyped. */
function HeadersEditor({ idBase, rows, onChange }: { idBase: string; rows: HeaderRow[]; onChange: (rows: HeaderRow[]) => void }) {
  const update = (index: number, patch: Partial<HeaderRow>) => onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  return (
    <div>
      {rows.map((row, index) => (
        <div key={index} style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
          <input
            id={`${idBase}-${index}-name`}
            aria-label={`Header ${index + 1} name`}
            style={{ flex: "1 1 120px", minWidth: 0 }}
            placeholder="Header name"
            value={row.name}
            onChange={(e) => update(index, { name: e.target.value })}
          />
          <input
            aria-label={`Header ${index + 1} value`}
            type="password"
            autoComplete="off"
            style={{ flex: "2 1 160px", minWidth: 0 }}
            placeholder="Value"
            value={row.value}
            onFocus={(e) => row.value === SECRET_MASK && e.currentTarget.select()}
            onChange={(e) => update(index, { value: e.target.value })}
          />
          <button type="button" className="secondary" aria-label={`Remove header ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}>
            <TrashIcon />
          </button>
        </div>
      ))}
      <button type="button" className="secondary" onClick={() => onChange([...rows, { name: "", value: "" }])}>
        + Add header
      </button>
    </div>
  );
}

/**
 * The message text of every event: what each one says by default, the {tokens} it can use, and a box to change it.
 * Blank uses the default. A template applies to every connection, as it always has.
 */
export function NotificationTemplates({ settings, saveSetting }: { settings: Record<string, string>; saveSetting: (key: string, value: string) => void | Promise<void> }) {
  const { meta, error } = useMeta();
  if (error) return <p style={{ color: "var(--danger)" }}>{error}</p>;
  if (!meta) return <p style={{ color: "var(--muted)" }}>Loading...</p>;
  return (
    <div className="form-panel">
      <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
        Customize the message text sent to every connection. Leave blank to use the default shown under each box. A token that an event does not have is left as typed.
      </p>
      {meta.templates.map((t) => {
        const value = settings[t.key] ?? "";
        const inputId = `notify-template-${t.event}`;
        return (
          <div key={t.key} style={{ marginBottom: 12 }}>
            <label htmlFor={inputId}>
              {t.label} - tokens: {t.tokens.map((token) => `{${token}}`).join(" ")}
            </label>
            <textarea
              id={inputId}
              key={settings[t.key] ?? `${t.key}-empty`}
              rows={2}
              defaultValue={value}
              placeholder={t.default}
              onBlur={(e) => {
                if (e.target.value !== value) saveSetting(t.key, e.target.value);
              }}
            />
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", fontSize: "0.78rem", color: "var(--muted)" }}>
              <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>Default: {t.default}</span>
              {value && (
                <button type="button" className="secondary" onClick={() => saveSetting(t.key, "")}>
                  Use default
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
