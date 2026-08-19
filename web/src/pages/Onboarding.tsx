import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client.js";

const DISMISS_KEY = "aonarr_onboarding_dismissed";

interface Counts {
  rootFolders: number;
  indexers: number;
  downloadClients: number;
}

/** Shown in place of the Dashboard right after admin setup, until a root folder exists or the
 * admin explicitly skips it — a guided checklist instead of an empty library with no context. */
export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [counts, setCounts] = useState<Counts | null>(null);

  useEffect(() => {
    Promise.all([
      api.get<any[]>("/root-folders").catch(() => []),
      api.get<any[]>("/indexers").catch(() => []),
      api.get<any[]>("/download-clients").catch(() => []),
    ]).then(([rootFolders, indexers, downloadClients]) =>
      setCounts({ rootFolders: rootFolders.length, indexers: indexers.length, downloadClients: downloadClients.length })
    );
  }, []);

  function skip() {
    localStorage.setItem(DISMISS_KEY, "1");
    onDone();
  }

  if (!counts) return null;

  const steps = [
    {
      done: counts.rootFolders > 0,
      title: "Add a root folder",
      body: "Tell AoNarr where your media library lives on disk — this is where new files get organized to.",
      to: "/settings",
      cta: "Go to Settings",
    },
    {
      done: counts.indexers > 0,
      title: "Add an indexer",
      body: "Connect a torrent/Usenet indexer (Torznab/Newznab, or a public tracker) so AoNarr can find releases to grab.",
      to: "/indexers",
      cta: "Go to Indexers",
    },
    {
      done: counts.downloadClients > 0,
      title: "Add a download client",
      body: "Connect qBittorrent, SABnzbd, or another supported client so grabbed releases actually download.",
      to: "/download-clients",
      cta: "Go to Download Clients",
    },
  ];

  return (
    <div style={{ maxWidth: 640, margin: "40px auto" }}>
      <h1>Welcome to AoNarr</h1>
      <p style={{ color: "var(--muted)" }}>
        A few things to set up before your library can find and grab anything. You can always come back to these in
        Settings later.
      </p>
      <div className="form-panel" style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 24 }}>
        {steps.map((step) => (
          <div key={step.title} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <span style={{ fontSize: "1.2rem" }}>{step.done ? "✅" : "⬜"}</span>
            <div style={{ flex: 1 }}>
              <strong>{step.title}</strong>
              <p style={{ margin: "4px 0", color: "var(--muted)", fontSize: "0.9rem" }}>{step.body}</p>
              {!step.done && (
                <Link to={step.to} onClick={onDone}>
                  {step.cta} →
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 24, display: "flex", gap: 8 }}>
        {counts.rootFolders > 0 ? (
          <button type="button" onClick={onDone}>
            Continue to Dashboard
          </button>
        ) : (
          <button type="button" className="secondary" onClick={skip}>
            Skip for now
          </button>
        )}
      </div>
    </div>
  );
}

export function shouldShowOnboarding(rootFolderCount: number): boolean {
  if (rootFolderCount > 0) return false;
  return localStorage.getItem(DISMISS_KEY) !== "1";
}
