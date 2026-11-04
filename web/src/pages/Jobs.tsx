import { Fragment, useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";
import { useSortableTable } from "../hooks/useSortableTable.js";
import type { JobRun, JobStatus } from "../types.js";
import { ZapIcon } from "../components/NavIcons.js";
import { CheckIcon, XIcon } from "../components/ActionIcons.js";
import { notify } from "../utils/notify.js";

function formatDuration(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const LAST_STATUS_LABELS: Record<string, string> = {
  success: "Success",
  error: "Error",
  cancelled: "Cancelled",
};

export default function Jobs() {
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  function load() {
    api.get<JobStatus[]>("/jobs").then(setJobs);
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  async function runNow(key: string) {
    try {
      await api.post(`/jobs/${key}/run`, {});
      setTimeout(load, 500);
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  async function cancel(key: string) {
    try {
      await api.post(`/jobs/${key}/cancel`, {});
      setTimeout(load, 500);
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  async function setEnabled(key: string, enabled: boolean) {
    try {
      await api.patch(`/jobs/${key}/enabled`, { enabled });
      load();
    } catch (e) {
      notify.error((e as Error).message);
    }
  }

  async function saveSchedule(key: string) {
    const schedule = editing[key];
    if (!schedule) return;
    setError(null);
    try {
      await api.patch(`/jobs/${key}/schedule`, { schedule });
      setEditing((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <h1>Jobs</h1>
      <p style={{ color: "var(--muted)" }}>
        Every background job AoNarr runs on a schedule — edit the schedule (cron expression, or
        seconds for interval-based jobs), trigger a run immediately, or cancel one that's in
        progress. Cancellation is best-effort: jobs that loop over items stop between items;
        jobs that are a handful of network calls may still finish the call already in flight.
        Jobs marked heavy (library scans, media checks, archival) run one at a time: a second
        one waits for the first. The last result of each job is kept across restarts, and a
        weekly job a restart skipped runs a couple of minutes after the next start.
      </p>
      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      <JobsTable jobs={jobs} editing={editing} setEditing={setEditing} onSave={saveSchedule} onRunNow={runNow} onCancel={cancel} onEnabled={setEnabled} />
    </div>
  );
}

function JobsTable({
  jobs,
  editing,
  setEditing,
  onSave,
  onRunNow,
  onCancel,
  onEnabled,
}: {
  jobs: JobStatus[];
  editing: Record<string, string>;
  setEditing: (fn: (prev: Record<string, string>) => Record<string, string>) => void;
  onSave: (key: string) => void;
  onRunNow: (key: string) => void;
  onCancel: (key: string) => void;
  onEnabled: (key: string, enabled: boolean) => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [runs, setRuns] = useState<JobRun[] | null>(null);
  // The row whose runs are wanted now: an answer for a row opened earlier is dropped when it arrives late.
  const wantedKey = useRef<string | null>(null);
  function toggleRuns(key: string) {
    if (openKey === key) {
      wantedKey.current = null;
      setOpenKey(null);
      return;
    }
    wantedKey.current = key;
    setOpenKey(key);
    setRuns(null);
    api
      .get<JobRun[]>(`/jobs/${key}/runs`)
      .then((rows) => {
        if (wantedKey.current === key) setRuns(rows);
      })
      .catch(() => {
        if (wantedKey.current === key) setRuns([]);
      });
  }
  const { sortRows, sortableHeader } = useSortableTable<JobStatus, "name" | "schedule" | "status" | "lastRun" | "nextRun">("name");
  const sorted = sortRows(jobs, (a, b, key) => {
    if (key === "name") return a.name.localeCompare(b.name);
    if (key === "schedule") return a.schedule.localeCompare(b.schedule);
    if (key === "status") return Number(a.running) - Number(b.running);
    if (key === "lastRun") return (a.lastRunAt ?? "").localeCompare(b.lastRunAt ?? "");
    return (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? "");
  });
  return (
    <table>
      <thead>
        <tr>
          {sortableHeader("name", "Job")}
          {sortableHeader("schedule", "Schedule")}
          {sortableHeader("status", "Status")}
          {sortableHeader("lastRun", "Last run")}
          {sortableHeader("nextRun", "Next run")}
          <th>Last result</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((j) => (
          <Fragment key={j.key}>
            <tr style={{ opacity: j.enabled === false ? 0.6 : 1 }}>
              <td>
                <input
                  type="checkbox"
                  checked={j.enabled !== false}
                  disabled={j.essential}
                  onChange={(e) => onEnabled(j.key, e.target.checked)}
                  title={j.essential ? "This job cannot be switched off" : j.enabled === false ? "Switched off: it runs only when you press Run now" : "Switched on"}
                  aria-label={`${j.name} switched on`}
                  style={{ marginRight: 8 }}
                />
                <button type="button" className="link-button" onClick={() => toggleRuns(j.key)} aria-expanded={openKey === j.key} title="Show the recent runs">
                  {j.name}
                </button>
              </td>
              <td>
                <input
                  value={editing[j.key] ?? j.schedule}
                  onChange={(e) => setEditing((prev) => ({ ...prev, [j.key]: e.target.value }))}
                  style={{ width: 140 }}
                  placeholder={j.scheduleType === "interval" ? "seconds" : "cron expression"}
                />
                {editing[j.key] !== undefined && editing[j.key] !== j.schedule && (
                  <button type="button" className="icon-button" style={{ marginLeft: 4 }} onClick={() => onSave(j.key)} title="Save" aria-label="Save schedule">
                    <CheckIcon />
                  </button>
                )}
              </td>
              <td>
                <span className={`badge ${j.running ? "ok" : ""}`}>{j.running ? "Running" : j.queued ? "Waiting" : j.enabled === false ? "Off" : "Idle"}</span>
                {j.heavy && (
                  <span style={{ marginLeft: 6, color: "var(--muted)", fontSize: "0.75rem" }} title="Heavy job: only one runs at a time">
                    heavy
                  </span>
                )}
              </td>
              <td>{j.lastRunAt ? new Date(j.lastRunAt).toLocaleString() : "Never"}</td>
              <td>{j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : "-"}</td>
              <td>
                {j.lastStatus && (
                  <span className={`badge ${j.lastStatus === "success" ? "ok" : j.lastStatus === "error" ? "danger" : ""}`}>
                    {LAST_STATUS_LABELS[j.lastStatus] ?? j.lastStatus}
                  </span>
                )}
                {j.lastError && <span style={{ marginLeft: 6, color: "var(--danger)", fontSize: "0.8rem" }}>{j.lastError}</span>}
                {j.lastDurationMs !== null && (
                  <span style={{ marginLeft: 6, color: "var(--muted)", fontSize: "0.8rem" }}>({formatDuration(j.lastDurationMs)})</span>
                )}
              </td>
              <td style={{ display: "flex", gap: 6 }}>
                <button type="button" className="icon-button" onClick={() => onRunNow(j.key)} disabled={j.running || j.queued} title="Run now" aria-label="Run now">
                  <ZapIcon />
                </button>
                <button type="button" className="icon-button danger" onClick={() => onCancel(j.key)} disabled={!j.running && !j.queued} title="Cancel" aria-label="Cancel">
                  <XIcon />
                </button>
              </td>
            </tr>
            {openKey === j.key && (
              <tr>
                <td colSpan={7}>
                  {runs === null ? (
                    <span style={{ color: "var(--muted)" }}>Loading...</span>
                  ) : runs.length === 0 ? (
                    <span style={{ color: "var(--muted)" }}>No run recorded yet. A job on a short interval is recorded only when it fails or takes long.</span>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>Started</th>
                          <th>Result</th>
                          <th>Took</th>
                          <th>Error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runs.map((run) => (
                          <tr key={run.id}>
                            <td>{new Date(run.startedAt).toLocaleString()}</td>
                            <td>
                              <span className={`badge ${run.status === "success" ? "ok" : run.status === "error" ? "danger" : ""}`}>{LAST_STATUS_LABELS[run.status] ?? run.status}</span>
                            </td>
                            <td>{formatDuration(run.durationMs)}</td>
                            <td style={{ color: "var(--danger)", fontSize: "0.8rem" }}>{run.error ?? ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
