import { useBackgroundJobs } from "../context/BackgroundJobsContext.js";
import { MinimizeIcon } from "./NavIcons.js";
import { XIcon } from "./ActionIcons.js";

/** A job's own percentage, or null while its total item count isn't known yet (e.g. Scan & Import
 * before its file walk finishes) — null renders as an animated indeterminate bar instead of a
 * static full-width one, which used to look indistinguishable from "already finished". */
function percentOf(job: { total: number; done: number }): number | null {
  return job.total > 0 ? Math.round((job.done / job.total) * 100) : null;
}

function ProgressBar({ job }: { job: { total: number; done: number; running: boolean; error: string | null } }) {
  const pct = percentOf(job);
  return (
    <div className={`progress-bar${pct === null && job.running ? " indeterminate" : ""}`} style={{ width: "100%" }}>
      <div style={pct !== null ? { width: `${pct}%`, background: job.error ? "var(--danger)" : undefined } : undefined} />
    </div>
  );
}

/** Floating, minimizable panel for every background job the app tracks: Scan & Import, Refresh, and
 * Match All Providers (server/src/services/backgroundJobs.ts, per library type) plus the Media
 * Analyzer's "Analyze Now" run (folded in from its own separate progress endpoint — see
 * BackgroundJobsContext). Mounted once in App.tsx so it's visible from any page. Hidden entirely
 * once there's nothing tracked at all; minimized to a small pill otherwise so it doesn't sit in the
 * way while it isn't the thing you're looking at, but stays one click away no matter what page you
 * navigate to next. */
export default function BackgroundJobsWidget() {
  const { jobs, minimized, setMinimized, dismissJob } = useBackgroundJobs();
  if (jobs.length === 0) return null;

  const running = jobs.filter((j) => j.running);
  const runningCount = running.length;
  // The pill's own compact progress bar: an average across every running job that has a known
  // total, so several jobs at once still collapse to one meaningful number instead of picking just
  // one arbitrarily — null (→ indeterminate) only once none of them know their total yet.
  const runningWithTotal = running.filter((j) => j.total > 0);
  const pillPct = runningCount === 0 ? null : runningWithTotal.length === 0 ? null : Math.round(runningWithTotal.reduce((sum, j) => sum + (j.done / j.total) * 100, 0) / runningWithTotal.length);

  if (minimized) {
    return (
      <button type="button" className="background-jobs-pill" onClick={() => setMinimized(false)} title="Show background job progress">
        <div className="background-jobs-pill-text">
          {runningCount > 0 && <span className="background-jobs-spinner" aria-hidden="true" />}
          {runningCount > 0 ? `${runningCount} job${runningCount === 1 ? "" : "s"} running` : `${jobs.length} job${jobs.length === 1 ? "" : "s"} finished`}
        </div>
        {runningCount > 0 && (
          <div className={`progress-bar${pillPct === null ? " indeterminate" : ""}`}>
            <div style={pillPct !== null ? { width: `${pillPct}%` } : undefined} />
          </div>
        )}
      </button>
    );
  }

  return (
    <div className="background-jobs-panel">
      <div className="background-jobs-panel-header">
        <strong>Background Jobs</strong>
        <button type="button" className="icon-button" onClick={() => setMinimized(true)} title="Minimize" aria-label="Minimize">
          <MinimizeIcon />
        </button>
      </div>
      <div className="background-jobs-panel-body">
        {jobs.map((job) => {
          const pct = percentOf(job);
          return (
            <div key={job.id} className="background-jobs-row">
              <div className="background-jobs-row-header">
                <span>{job.label}</span>
                {!job.running && (
                  <button type="button" className="icon-button" onClick={() => dismissJob(job.id)} title="Dismiss" aria-label="Dismiss">
                    <XIcon />
                  </button>
                )}
              </div>
              <ProgressBar job={job} />
              <div className="background-jobs-row-status">
                {job.error ? `Failed: ${job.error}` : job.running ? (pct !== null ? `${job.done} of ${job.total} (${pct}%)` : "Working…") : "Finished"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
