import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client.js";
import { formatBytes } from "../utils/format.js";
import { notify } from "../utils/notify.js";

/**
 * Throttlearr on the Download Clients page: the global switches, the checks run before a release takes a slot, and the
 * limits of each client (how many jobs, how many bytes left, adds per hour, free disk, and the hours it may be fed).
 * Everything is saved as one settings object (PUT /api/throttlearr/settings); the server validates it.
 */

interface ThrottleWindow {
  days: number[];
  from: string;
  to: string;
}
interface ClientLimits {
  maxActive: number | null;
  maxActiveBytes: number | null;
  addsPerHour: number | null;
  minFreeBytes: number | null;
  windows: ThrottleWindow[];
}
interface ThrottlearrSettings {
  version: number;
  enabled: boolean;
  dryRun: boolean;
  holdAll: boolean;
  maxHeldAgeHours: number;
  bypassManual: boolean;
  clients: Record<string, ClientLimits>;
  priority: { movies: number; recentTv: number; backlog: number; backlogOnlyAtNight: boolean; nightFrom: string; nightTo: string };
  perTitleLimit: number | null;
  preflight: { enabled: boolean; junkNames: boolean; sizeFloor: boolean; inspectNzb: boolean; strictIdentity: boolean };
}
interface ClientGateStatus {
  id: number;
  name: string;
  type: string;
  limited: boolean;
  held: number;
  oldestHeldAt: string | null;
  active: number | null;
  bytesLeft: number | null;
  source: "client" | "own" | null;
}
interface Status {
  enabled: boolean;
  dryRun: boolean;
  held: number;
  clients: ClientGateStatus[];
  job: { enabled: boolean; lastRunAt: string | null; lastStatus: string | null; lastError: string | null; nextRunAt: string | null } | null;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const GB = 1_000_000_000;
const NO_LIMITS: ClientLimits = { maxActive: null, maxActiveBytes: null, addsPerHour: null, minFreeBytes: null, windows: [] };

/** A text box value to a limit: empty or not above zero is "no limit". */
function toLimit(text: string, scale = 1): number | null {
  const n = Number(text);
  return text.trim() !== "" && Number.isFinite(n) && n > 0 ? Math.round(n * scale) : null;
}
const fromLimit = (v: number | null, scale = 1) => (v === null ? "" : String(Math.round((v / scale) * 100) / 100));

export default function ThrottlearrPanel() {
  const [settings, setSettings] = useState<ThrottlearrSettings | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const loadStatus = useCallback(() => {
    api.get<Status>("/throttlearr/status").then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    api.get<ThrottlearrSettings>("/throttlearr/settings").then(setSettings).catch((e) => notify.error((e as Error).message));
    loadStatus();
  }, [loadStatus]);

  if (!settings) return null;

  function change(next: ThrottlearrSettings) {
    setSettings(next);
    setDirty(true);
  }
  const limitsOf = (id: number): ClientLimits => settings!.clients[String(id)] ?? NO_LIMITS;
  function setLimits(id: number, patch: Partial<ClientLimits>) {
    change({ ...settings!, clients: { ...settings!.clients, [String(id)]: { ...limitsOf(id), ...patch } } });
  }
  function setWindow(id: number, index: number, patch: Partial<ThrottleWindow> | null) {
    const windows = limitsOf(id).windows.slice();
    if (patch === null) windows.splice(index, 1);
    else windows[index] = { ...windows[index], ...patch };
    setLimits(id, { windows });
  }

  async function save() {
    setSaving(true);
    try {
      const saved = await api.put<ThrottlearrSettings>("/throttlearr/settings", settings);
      setSettings(saved);
      setDirty(false);
      notify.success("Throttlearr settings saved.");
      loadStatus();
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const check = (label: string, value: boolean, set: (v: boolean) => void, hint?: string) => (
    <label style={{ display: "flex", alignItems: "flex-start", gap: 8, margin: "4px 0" }}>
      <input type="checkbox" checked={value} onChange={(e) => set(e.target.checked)} style={{ marginTop: 3 }} />
      <span>
        {label}
        {hint && <span style={{ display: "block", color: "var(--muted)", fontSize: "0.8rem" }}>{hint}</span>}
      </span>
    </label>
  );

  return (
    <section aria-labelledby="throttlearr-heading" style={{ marginTop: 32 }}>
      <h2 id="throttlearr-heading">Throttlearr</h2>
      <p style={{ color: "var(--muted)" }}>
        Keeps grabs back until a download client has room, so a big backlog does not fill SABnzbd or qBittorrent with thousands of
        jobs. A held grab waits in Activity, with the reason, and is sent as room appears: movies first, then recent episodes, then
        the backlog. Off by default.
      </p>

      {status && status.held > 0 && (
        <p className="badge" style={{ display: "inline-block" }}>
          {status.held} grab{status.held === 1 ? "" : "s"} held now
        </p>
      )}
      {status?.job?.lastError && <p style={{ color: "var(--danger)" }}>The release job's last run failed: {status.job.lastError}</p>}

      <div className="form-panel">
        {check("Use Throttlearr", settings.enabled, (v) => change({ ...settings, enabled: v }), "Off: every grab goes to its download client at once.")}
        {check("Dry run", settings.dryRun, (v) => change({ ...settings, dryRun: v }), "Only write to the log what would be held. Nothing is held.")}
        {check("Hold everything", settings.holdAll, (v) => change({ ...settings, holdAll: v }), "Nothing is sent to any client until this is off. For maintenance on the client.")}
        {check("Let hand-picked grabs through", settings.bypassManual, (v) => change({ ...settings, bypassManual: v }), "A release you choose in Interactive Search, or force with Grab anyway, is never held.")}

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 8 }}>
          <div>
            <label htmlFor="throttlearr-max-age">Drop a grab held longer than (hours)</label>
            <input
              id="throttlearr-max-age"
              type="number"
              min={1}
              max={720}
              value={settings.maxHeldAgeHours}
              onChange={(e) => change({ ...settings, maxHeldAgeHours: Number(e.target.value) || 72 })}
              style={{ maxWidth: 120 }}
            />
          </div>
          <div>
            <label htmlFor="throttlearr-per-title">Most jobs of one title at a client</label>
            <input
              id="throttlearr-per-title"
              type="number"
              min={0}
              placeholder="no limit"
              value={settings.perTitleLimit ?? ""}
              onChange={(e) => change({ ...settings, perTitleLimit: toLimit(e.target.value) })}
              style={{ maxWidth: 120 }}
            />
          </div>
        </div>

        <details style={{ marginTop: 8 }}>
          <summary>Backlog at night</summary>
          {check("Send old episodes (aired over a year ago) only at night", settings.priority.backlogOnlyAtNight, (v) => change({ ...settings, priority: { ...settings.priority, backlogOnlyAtNight: v } }))}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label htmlFor="throttlearr-night-from">From</label>
            <input id="throttlearr-night-from" type="time" value={settings.priority.nightFrom} onChange={(e) => change({ ...settings, priority: { ...settings.priority, nightFrom: e.target.value } })} />
            <label htmlFor="throttlearr-night-to">to</label>
            <input id="throttlearr-night-to" type="time" value={settings.priority.nightTo} onChange={(e) => change({ ...settings, priority: { ...settings.priority, nightTo: e.target.value } })} />
            <span style={{ color: "var(--muted)", fontSize: "0.8rem" }}>server time</span>
          </div>
        </details>

        <details style={{ marginTop: 8 }}>
          <summary>Checks before a release takes a slot</summary>
          <p style={{ color: "var(--muted)", fontSize: "0.8rem" }}>Run only while Throttlearr is on, for films and series. A refused release is skipped and the next best one is tried.</p>
          {check("Run the checks", settings.preflight.enabled, (v) => change({ ...settings, preflight: { ...settings.preflight, enabled: v } }))}
          {check("Refuse samples, trailers, extras, .nfo files, incomplete and passworded names", settings.preflight.junkNames, (v) => change({ ...settings, preflight: { ...settings.preflight, junkNames: v } }))}
          {check("Refuse a release far smaller than its quality and runtime need", settings.preflight.sizeFloor, (v) => change({ ...settings, preflight: { ...settings.preflight, sizeFloor: v } }))}
          {check("Read the NZB's file list and refuse one with no video, a password or a program", settings.preflight.inspectNzb, (v) => change({ ...settings, preflight: { ...settings.preflight, inspectNzb: v } }))}
          {check(
            "Judge a release by its name only, not by the id its indexer gives it",
            settings.preflight.strictIdentity,
            (v) => change({ ...settings, preflight: { ...settings.preflight, strictIdentity: v } }),
            "Stops indexers vouching for the wrong film. A release under a title AoNarr has no alias for (a foreign title) is lost."
          )}
        </details>
      </div>

      <h3>Limits per download client</h3>
      <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>Leave a box empty for no limit. A client with no limit at all is never held.</p>
      {(status?.clients ?? []).length === 0 && <p className="empty">No download clients yet.</p>}
      {(status?.clients ?? []).map((c) => {
        const l = limitsOf(c.id);
        return (
          <div key={c.id} className="form-panel" style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <strong>{c.name}</strong>
              <span style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
                {c.active !== null ? `${c.active} job${c.active === 1 ? "" : "s"} now${c.bytesLeft ? `, ${formatBytes(c.bytesLeft)} left` : ""}${c.source === "own" ? " (AoNarr's own count)" : ""}` : "load unknown"}
                {c.held > 0 ? ` · ${c.held} held` : ""}
              </span>
            </div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 8 }}>
              <div>
                <label htmlFor={`throttlearr-max-active-${c.id}`}>Most jobs at once</label>
                <input id={`throttlearr-max-active-${c.id}`} type="number" min={0} value={fromLimit(l.maxActive)} onChange={(e) => setLimits(c.id, { maxActive: toLimit(e.target.value) })} style={{ maxWidth: 110 }} />
              </div>
              <div>
                <label htmlFor={`throttlearr-max-gb-${c.id}`}>Most GB still to download</label>
                <input id={`throttlearr-max-gb-${c.id}`} type="number" min={0} value={fromLimit(l.maxActiveBytes, GB)} onChange={(e) => setLimits(c.id, { maxActiveBytes: toLimit(e.target.value, GB) })} style={{ maxWidth: 110 }} />
              </div>
              <div>
                <label htmlFor={`throttlearr-adds-${c.id}`}>Most adds per hour</label>
                <input id={`throttlearr-adds-${c.id}`} type="number" min={0} value={fromLimit(l.addsPerHour)} onChange={(e) => setLimits(c.id, { addsPerHour: toLimit(e.target.value) })} style={{ maxWidth: 110 }} />
              </div>
              <div>
                <label htmlFor={`throttlearr-free-${c.id}`}>Keep this many GB free</label>
                <input id={`throttlearr-free-${c.id}`} type="number" min={0} value={fromLimit(l.minFreeBytes, GB)} onChange={(e) => setLimits(c.id, { minFreeBytes: toLimit(e.target.value, GB) })} style={{ maxWidth: 110 }} />
              </div>
            </div>

            <div style={{ marginTop: 8 }}>
              <span style={{ fontSize: "0.85rem", color: "var(--muted)" }}>Hours it may be fed (none: any time; server time)</span>
              {l.windows.map((w, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", margin: "4px 0" }}>
                  {DAYS.map((d, day) => (
                    <label key={d} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                      <input
                        type="checkbox"
                        checked={w.days.includes(day)}
                        onChange={(e) => setWindow(c.id, i, { days: e.target.checked ? [...w.days, day].sort() : w.days.filter((x) => x !== day) })}
                        aria-label={`${d} for window ${i + 1} of ${c.name}`}
                      />
                      {d}
                    </label>
                  ))}
                  <input type="time" value={w.from} onChange={(e) => setWindow(c.id, i, { from: e.target.value })} aria-label={`From, window ${i + 1} of ${c.name}`} />
                  <span>to</span>
                  <input type="time" value={w.to} onChange={(e) => setWindow(c.id, i, { to: e.target.value })} aria-label={`To, window ${i + 1} of ${c.name}`} />
                  <button type="button" className="secondary" onClick={() => setWindow(c.id, i, null)} aria-label={`Remove window ${i + 1} of ${c.name}`}>
                    Remove
                  </button>
                </div>
              ))}
              <button type="button" className="secondary" onClick={() => setLimits(c.id, { windows: [...l.windows, { days: [0, 1, 2, 3, 4, 5, 6], from: "23:00", to: "07:00" }] })}>
                Add hours
              </button>
            </div>
          </div>
        );
      })}

      <div className="toolbar" style={{ gap: 8 }}>
        <button type="button" onClick={save} disabled={saving || !dirty}>
          {saving ? "Saving..." : "Save Throttlearr settings"}
        </button>
        <button type="button" className="secondary" onClick={loadStatus}>
          Refresh load
        </button>
        {dirty && <span style={{ color: "var(--muted)" }}>Unsaved changes</span>}
      </div>
    </section>
  );
}
