import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Top-level safety net — before this existed, ANY uncaught render exception anywhere in the app
 * (a bad bulk-delete leaving stale selected-row state, a null-pointer on a field a backend response
 * happened not to include, etc.) unmounted the whole React tree to a permanently blank page, with
 * no way to recover short of a hard reload — and if whatever triggered it was itself persisted
 * (e.g. a bad value in localStorage), even a reload wouldn't help. This renders a plain recovery
 * screen instead, and "Reload" is a real page navigation (not just resetting this boundary's own
 * state), so it re-fetches everything fresh rather than re-mounting on top of whatever state caused
 * the crash in the first place.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary] caught a render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ maxWidth: 560, margin: "10vh auto", padding: 24, textAlign: "center" }}>
          <h1 style={{ marginBottom: 8 }}>Something went wrong</h1>
          <p style={{ color: "var(--muted)", marginBottom: 16 }}>
            AoNarr hit an unexpected error and couldn't continue rendering this page. Reloading
            usually fixes it — if it keeps happening, check the server logs for what triggered it.
          </p>
          <p
            style={{
              fontFamily: "monospace",
              fontSize: "0.8rem",
              color: "var(--danger)",
              background: "var(--bg-alt, rgba(128,128,128,0.1))",
              padding: 12,
              borderRadius: 6,
              textAlign: "left",
              overflowX: "auto",
              marginBottom: 16,
            }}
          >
            {this.state.error.message}
          </p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
