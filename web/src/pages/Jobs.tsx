import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { useSortableTable } from "../hooks/useSortableTable.js";
import type { JobStatus } from "../types.js";

function formatDuration(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

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
      alert((e as Error).message);
    }
  }

  async function cancel(key: string) {
    try {
      await api.post(`/jobs/${key}/cancel`, {});
      setTimeout(load, 500);
    } catch (e) {
      alert((e as Error).message);
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
      </p>
      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      <JobsTable jobs={jobs} editing={editing} setEditing={setEditing} onSave={saveSchedule} onRunNow={runNow} onCancel={cancel} />
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
}: {
  jobs: JobStatus[];
  editing: Record<string, string>;
  setEditing: (fn: (prev: Record<string, string>) => Record<string, string>) => void;
  onSave: (key: string) => void;
  onRunNow: (key: string) => void;
  onCancel: (key: string) => void;
}) {
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
            <tr key={j.key}>
              <td>{j.name}</td>
              <td>
                <input
                  value={editing[j.key] ?? j.schedule}
                  onChange={(e) => setEditing((prev) => ({ ...prev, [j.key]: e.target.value }))}
                  style={{ width: 140 }}
                  placeholder={j.scheduleType === "interval" ? "seconds" : "cron expression"}
                />
                {editing[j.key] !== undefined && editing[j.key] !== j.schedule && (
                  <button type="button" className="secondary" style={{ marginLeft: 4 }} onClick={() => onSave(j.key)}>
                    Save
                  </button>
                )}
              </td>
              <td>
                <span className={`badge ${j.running ? "ok" : ""}`}>{j.running ? "Running" : "Idle"}</span>
              </td>
              <td>{j.lastRunAt ? new Date(j.lastRunAt).toLocaleString() : "Never"}</td>
              <td>{j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : "-"}</td>
              <td>
                {j.lastStatus && (
                  <span className={`badge ${j.lastStatus === "success" ? "ok" : j.lastStatus === "error" ? "danger" : ""}`}>
                    {j.lastStatus}
                  </span>
                )}
                {j.lastError && <span style={{ marginLeft: 6, color: "var(--danger)", fontSize: "0.8rem" }}>{j.lastError}</span>}
                {j.lastDurationMs !== null && (
                  <span style={{ marginLeft: 6, color: "var(--muted)", fontSize: "0.8rem" }}>({formatDuration(j.lastDurationMs)})</span>
                )}
              </td>
              <td style={{ display: "flex", gap: 6 }}>
                <button className="secondary" onClick={() => onRunNow(j.key)} disabled={j.running}>
                  Run now
                </button>
                <button className="danger" onClick={() => onCancel(j.key)} disabled={!j.running}>
                  Cancel
                </button>
              </td>
            </tr>
        ))}
      </tbody>
    </table>
  );
}
