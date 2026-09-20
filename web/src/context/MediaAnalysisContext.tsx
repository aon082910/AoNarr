import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client.js";
import { notify } from "../utils/notify.js";

export interface AnalysisProgress {
  running: boolean;
  type: string | null;
  total: number;
  done: number;
  failed: number;
  startedAt: number | null;
  finishedAt: number | null;
}

interface MediaAnalysisContextValue {
  progress: AnalysisProgress | null;
  runAnalysis: (type: string) => Promise<void>;
}

const MediaAnalysisContext = createContext<MediaAnalysisContextValue | null>(null);

/**
 * The actual analysis loop already runs entirely server-side, independent of any one request
 * (server/src/services/mediaAnalysis.ts's `runLibraryAnalysis` is fired-and-forgotten by the `/run`
 * route and keeps writing to the DB regardless of what page is open) — the bug users hit
 * ("navigate away and it stops") was never the backend, it was that MediaAnalyzer.tsx used to own
 * its progress-polling `setInterval` as component-local state, torn down by its own unmount effect
 * the instant you left the page. Mounted once here (alongside AuthProvider, never remounted by
 * route changes — see ApiKeyGate.tsx) so a run's progress — and its completion toast — survives
 * navigating anywhere in the app, exactly like AuthContext's own single-mount-point pattern.
 */
export function MediaAnalysisProvider({ children }: { children: ReactNode }) {
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function pollProgress() {
    api
      .get<AnalysisProgress>("/media-analysis/progress")
      .then((p) => {
        setProgress(p);
        if (!p.running) {
          stopPolling();
          notify.success(`Analysis finished — ${p.done - p.failed} probed${p.failed > 0 ? `, ${p.failed} failed` : ""}.`);
        }
      })
      .catch(() => stopPolling());
  }

  // Picks up an already-running analysis (started before this session loaded, e.g. a scheduled
  // trigger or a run kicked off from another device) rather than only ever noticing a run this
  // provider itself started.
  useEffect(() => {
    api
      .get<AnalysisProgress>("/media-analysis/progress")
      .then((p) => {
        if (p.running) {
          setProgress(p);
          pollRef.current = setInterval(pollProgress, 1200);
        }
      })
      .catch(() => {});
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runAnalysis(type: string) {
    const qs = type ? `?type=${type}` : "";
    const result = await api.post<{ started: boolean; reason?: string }>(`/media-analysis/run${qs}`, {});
    if (!result.started) {
      notify.info("An analysis run is already in progress — showing its live progress.");
    }
    setProgress({ running: true, type: type || null, total: 0, done: 0, failed: 0, startedAt: Date.now(), finishedAt: null });
    stopPolling();
    pollRef.current = setInterval(pollProgress, 1200);
  }

  return <MediaAnalysisContext.Provider value={{ progress, runAnalysis }}>{children}</MediaAnalysisContext.Provider>;
}

export function useMediaAnalysis(): MediaAnalysisContextValue {
  const ctx = useContext(MediaAnalysisContext);
  if (!ctx) throw new Error("useMediaAnalysis must be used within MediaAnalysisProvider");
  return ctx;
}
