import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client.js";
import { notify } from "../utils/notify.js";
import { useMediaTypes } from "../hooks/useMediaTypes.js";

export interface BackgroundJobProgress {
  id: string;
  kind: "scan" | "matchProviders" | "refresh" | "organize" | "mediaAnalysis";
  type: string;
  label: string;
  total: number;
  done: number;
  running: boolean;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

/** GET /media-analysis/progress's own shape (server/src/services/mediaAnalysis.ts's
 * AnalysisProgress) — a single global slot rather than several tracked jobs, and a `failed` count
 * instead of an error string, so it's folded into a BackgroundJobProgress-shaped entry below rather
 * than changing that already-working, separately-tested system to match this one. */
interface AnalysisProgressResponse {
  running: boolean;
  type: string | null;
  total: number;
  done: number;
  failed: number;
  startedAt: number | null;
  finishedAt: number | null;
}

interface BackgroundJobsContextValue {
  jobs: BackgroundJobProgress[];
  /** True once at least one job is running, or minimize/restore is otherwise meaningful — the
   * widget only renders anything at all once this is true. */
  minimized: boolean;
  setMinimized: (v: boolean) => void;
  /** POSTs the given start route (e.g. "/media/scan-import?type=movie") and folds the response into
   * local state immediately — same "optimistic start, then let polling confirm/replace it" approach
   * MediaAnalysisContext's runAnalysis uses. Expands the widget so a job the user just triggered is
   * visible right away instead of only appearing minimized. `body`, when given, is posted instead of
   * an empty object — the Library page's "selected items" bulk actions send `{mediaItemIds}` so the
   * server scopes the job to just those items instead of the whole type. */
  startJob: (kind: BackgroundJobProgress["kind"], type: string, label: string, startPath: string, body?: unknown) => Promise<void>;
  /** Removes one finished job from the visible list early, without waiting for the server's own
   * 60s retention window to drop it — the row disappearing is purely a client-side dismiss (the
   * job itself already finished; nothing server-side changes). */
  dismissJob: (id: string) => void;
}

const BackgroundJobsContext = createContext<BackgroundJobsContextValue | null>(null);

/**
 * Mirrors MediaAnalysisContext.tsx's pattern (mounted once, above App.tsx, outside any route — see
 * ApiKeyGate.tsx — so polling and the widget's state survive navigating anywhere), generalized to
 * track several jobs at once instead of one single global slot: a scan for Movies and a
 * match-providers run for TV Shows can both be in flight together, each getting its own row and its
 * own progress bar in the widget. Every "click a button, it keeps working after you leave the page"
 * action in the app shows up here: Scan & Import, Refresh, and Match All Providers (all tracked
 * server-side in services/backgroundJobs.ts) plus the Media Analyzer's "Analyze Now" run (tracked by
 * its own separate, already-working MediaAnalysisContext/AnalysisProgress system — merged into this
 * widget's list by additionally polling its progress endpoint, not by touching that system).
 */
export function BackgroundJobsProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<BackgroundJobProgress[]>([]);
  const [minimized, setMinimized] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollFailuresRef = useRef(0);
  const knownIdsRef = useRef(new Set<string>());
  const dismissedRef = useRef(new Set<string>());
  const mediaTypes = useMediaTypes();
  const mediaTypesRef = useRef(mediaTypes);
  mediaTypesRef.current = mediaTypes;

  function mediaAnalysisAsJob(p: AnalysisProgressResponse): BackgroundJobProgress | null {
    if (p.startedAt === null) return null; // never run on this server instance
    const typeLabel = p.type ? (mediaTypesRef.current.find((t) => t.key === p.type)?.label ?? p.type) : "All Libraries";
    return {
      id: `mediaAnalysis:${p.type ?? "all"}`,
      kind: "mediaAnalysis",
      type: p.type ?? "all",
      label: `Analyze Media — ${typeLabel}`,
      total: p.total,
      done: p.done,
      running: p.running,
      startedAt: p.startedAt,
      finishedAt: p.finishedAt,
      error: !p.running && p.failed > 0 ? `${p.failed} of ${p.done} failed` : null,
    };
  }

  function stopPolling() {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }

  function schedulePoll(delayMs: number) {
    stopPolling();
    pollRef.current = setTimeout(pollJobs, delayMs);
  }

  function pollJobs() {
    pollRef.current = null;
    Promise.all([
      api.get<BackgroundJobProgress[]>("/background-jobs"),
      // A non-admin can't read this (same admin gate as /background-jobs) and older/unrelated
      // failures shouldn't take down the rest of the widget — treated as "no analysis job to show".
      api.get<AnalysisProgressResponse>("/media-analysis/progress").catch(() => null),
    ])
      .then(([list, analysis]) => {
        pollFailuresRef.current = 0;
        const analysisJob = analysis ? mediaAnalysisAsJob(analysis) : null;
        const merged = analysisJob ? [...list, analysisJob] : list;
        // A job that finished between one poll and the next gets a toast, once per run (keyed by
        // id+startedAt so a later run of the same kind/type reusing that id still gets its own
        // toast) rather than once per poll tick — same reasoning as MediaAnalysisContext's own
        // completion toast.
        const stillFresh = merged.filter((j) => !dismissedRef.current.has(`${j.id}:${j.startedAt}`));
        for (const job of stillFresh) {
          const key = `${job.id}:${job.startedAt}`;
          if (job.finishedAt !== null && !knownIdsRef.current.has(key)) {
            if (job.error) notify.error(`${job.label} failed: ${job.error}`);
            else notify.success(`${job.label} finished${job.total > 0 ? ` — ${job.done} of ${job.total}` : ""}.`);
          }
          knownIdsRef.current.add(key);
        }
        setJobs(stillFresh);
        if (stillFresh.some((j) => j.running)) schedulePoll(1500);
        else schedulePoll(5000); // idle cadence — still catches a job started from another session/tab
      })
      // A single failed poll (Wi-Fi blip, a laptop waking) backs off and retries rather than
      // freezing the widget until a full page reload, same reasoning as MediaAnalysisContext.
      .catch(() => schedulePoll(Math.min(30_000, 1500 * 2 ** ++pollFailuresRef.current)));
  }

  // Picks up any already-running job on mount (started before this session loaded, or from another
  // tab/device) and starts the idle poll regardless, so a job started elsewhere is still noticed.
  useEffect(() => {
    pollJobs();
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startJob(kind: BackgroundJobProgress["kind"], type: string, label: string, startPath: string, body?: unknown) {
    const result = await api.post<{ started: boolean; reason?: string }>(startPath, body ?? {});
    if (!result.started) {
      notify.info(`${label} is already running — showing its live progress.`);
    } else {
      const optimistic: BackgroundJobProgress = {
        id: `${kind}:${type}`,
        kind,
        type,
        label,
        total: 0,
        done: 0,
        running: true,
        startedAt: Date.now(),
        finishedAt: null,
        error: null,
      };
      setJobs((prev) => [optimistic, ...prev.filter((j) => j.id !== optimistic.id)]);
    }
    setMinimized(false);
    pollFailuresRef.current = 0;
    schedulePoll(300);
  }

  function dismissJob(id: string) {
    setJobs((prev) => {
      const job = prev.find((j) => j.id === id);
      if (job) dismissedRef.current.add(`${job.id}:${job.startedAt}`);
      return prev.filter((j) => j.id !== id);
    });
  }

  return (
    <BackgroundJobsContext.Provider value={{ jobs, minimized, setMinimized, startJob, dismissJob }}>{children}</BackgroundJobsContext.Provider>
  );
}

export function useBackgroundJobs(): BackgroundJobsContextValue {
  const ctx = useContext(BackgroundJobsContext);
  if (!ctx) throw new Error("useBackgroundJobs must be used within BackgroundJobsProvider");
  return ctx;
}
