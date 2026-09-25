import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import Dashboard from "./Dashboard.js";
import { AuthProvider } from "../context/AuthContext.js";
import type { AuthMe, MediaItem } from "../types.js";
import { MEDIA_TYPES, mockApi } from "../test/mockApi.js";

const healthy = { configWarnings: [], indexers: [], downloadClients: [], diskWarnings: [] };

function renderPage(me: AuthMe, overrides: Record<string, unknown> = {}) {
  const fetchMock = mockApi({
    "/api/auth/me": me,
    "/api/media-types": MEDIA_TYPES,
    "/api/dashboard/recently-added": [],
    "/api/dashboard/recent": [],
    "/api/dashboard/recently-watched": [],
    "/api/dashboard/library-sizes": { movie: 2e12 },
    "/api/dashboard/library-counts": { movie: 7 },
    "/api/wanted/calendar": [],
    "/api/system/health": healthy,
    ...overrides,
  });
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Dashboard />
      </AuthProvider>
    </MemoryRouter>
  );
  return fetchMock;
}

describe("Dashboard", () => {
  it("renders the library summary and recently added items once loaded", async () => {
    const item = { id: 1, type: "movie", title: "Heat", year: 1995, posterUrl: null } as MediaItem;
    renderPage({ isAdmin: true }, { "/api/dashboard/recently-added": [item] });

    expect(await screen.findByText("7 item(s) across every library · 2.0 TB total on disk")).toBeInTheDocument();
    expect(screen.getByText("Heat")).toBeInTheDocument();
    expect(screen.getByText("Upcoming (next 14 days)")).toBeInTheDocument();
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  it("shows an error instead of empty widgets when a request fails", async () => {
    renderPage({ isAdmin: true }, {
      "/api/dashboard/recent": () => new Response(JSON.stringify({ error: "database is locked" }), { status: 500 }),
    });

    expect(await screen.findByText("Couldn't load the dashboard")).toBeInTheDocument();
    expect(screen.getByText("database is locked")).toBeInTheDocument();
  });

  it("surfaces health problems for admins, collapsed until expanded", async () => {
    const user = userEvent.setup();
    renderPage({ isAdmin: true }, {
      "/api/system/health": {
        ...healthy,
        indexers: [{ id: 1, name: "NZBgeek", ok: false }],
        diskWarnings: [{ rootFolderId: 1, path: "/mnt/user/media", percentFree: 3 }],
      },
    });

    expect(await screen.findByText("2 health issues")).toBeInTheDocument();
    expect(screen.queryByText('Indexer "NZBgeek" is unreachable')).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Expand health issues" }));
    expect(screen.getByText('Indexer "NZBgeek" is unreachable')).toBeInTheDocument();
    expect(screen.getByText('"/mnt/user/media" is low on disk space (3% free)')).toBeInTheDocument();
  });

  it("hides admin-only widgets and skips admin-only requests for household users", async () => {
    const fetchMock = renderPage({ isAdmin: false, user: { id: 2, username: "kid", role: "user", allowedTypes: ["movie"] } });

    expect(await screen.findByText("Recently Added")).toBeInTheDocument();
    expect(screen.queryByText("Upcoming (next 14 days)")).not.toBeInTheDocument();
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((u) => u.startsWith("/api/wanted/calendar"))).toBe(false);
    expect(urls).not.toContain("/api/system/health");
  });
});
