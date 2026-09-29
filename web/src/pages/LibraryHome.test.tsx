import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import LibraryHome from "./LibraryHome.js";
import { AuthProvider } from "../context/AuthContext.js";
import type { AuthMe, MediaItem } from "../types.js";
import { MEDIA_TYPES, mockApi } from "../test/mockApi.js";

function renderPage(me: AuthMe, overrides: Record<string, unknown> = {}) {
  mockApi({
    "/api/auth/me": me,
    "/api/media-types": MEDIA_TYPES,
    "/api/dashboard/recently-added": [],
    "/api/dashboard/library-counts": { movie: 12, series: 3 },
    "/api/dashboard/library-sizes": { movie: 4e12, series: 1e12 },
    ...overrides,
  });
  return render(
    <MemoryRouter initialEntries={["/library"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path="/library" element={<LibraryHome />} />
          <Route path="/library/:type" element={<p>type page</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

describe("LibraryHome", () => {
  it("shows a card per library type with its count, plus the total size", async () => {
    renderPage({ isAdmin: true });

    expect(await screen.findByText("Movies")).toBeInTheDocument();
    expect(screen.getByText("TV Shows")).toBeInTheDocument();
    expect(await screen.findByText("12 item(s)")).toBeInTheDocument();
    expect(screen.getByText("3 item(s)")).toBeInTheDocument();
    expect(await screen.findByText("Total library size on disk: 5.0 TB")).toBeInTheDocument();
    expect(screen.getByText("Nothing added yet.")).toBeInTheDocument();
  });

  it("only shows the types a household user is allowed to see", async () => {
    renderPage({ isAdmin: false, user: { id: 2, username: "kid", role: "user", allowedTypes: ["series"] } });

    expect(await screen.findByText("TV Shows")).toBeInTheDocument();
    expect(screen.queryByText("Movies")).not.toBeInTheDocument();
  });

  it("links recently added items to their detail page", async () => {
    const item = { id: 42, type: "movie", title: "Heat", year: 1995, posterUrl: null } as MediaItem;
    renderPage({ isAdmin: true }, { "/api/dashboard/recently-added": [item] });

    const link = await screen.findByRole("link", { name: /Heat/ });
    expect(link).toHaveAttribute("href", "/media/42");
  });

  it("opens a library type when its card is clicked", async () => {
    const user = userEvent.setup();
    renderPage({ isAdmin: true });

    await user.click(await screen.findByText("Movies"));
    expect(await screen.findByText("type page")).toBeInTheDocument();
  });
});
