import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api/client.js";
import Dashboard from "./pages/Dashboard.js";
import Onboarding, { shouldShowOnboarding } from "./pages/Onboarding.js";
import { useAuth } from "./context/AuthContext.js";
import NotificationsToggle from "./components/NotificationsToggle.js";
import ThemeToggle from "./components/ThemeToggle.js";
import LayoutWidthToggle from "./components/LayoutWidthToggle.js";
import CommandPalette from "./components/CommandPalette.js";
import DropdownMenu from "./components/DropdownMenu.js";
import { useMediaTypes } from "./hooks/useMediaTypes.js";
import { useCustomizableLayout } from "./hooks/useCustomizableLayout.js";
import {
  HomeIcon,
  SearchIcon,
  FilmIcon,
  PlusCircleIcon,
  ActivityIcon,
  CalendarIcon,
  LayersIcon,
  CompassIcon,
  RadioIcon,
  ListIcon,
  CheckSquareIcon,
  AlertTriangleIcon,
  ArrowUpCircleIcon,
  StarIcon,
  InboxIcon,
  DownloadIcon,
  CpuIcon,
  ColumnsIcon,
  HardDriveIcon,
  ZapIcon,
  MessageCircleIcon,
  SlidersIcon,
  UsersIcon,
  CodeIcon,
  ShieldIcon,
  SlashIcon,
  CopyIcon,
  ClockIcon,
  ShareIcon,
  BriefcaseIcon,
  BarChartIcon,
  WifiIcon,
  RotateCcwIcon,
  GlobeIcon,
  ServerIcon,
  BellIcon,
  UserIcon,
} from "./components/NavIcons.js";

// Every other page is lazy-loaded (route-based code splitting): Dashboard/Onboarding stay eager
// since one of them always renders on first paint, but everything reachable only by navigating
// (Settings, the Swagger-powered API Docs page, etc.) has no reason to sit in the initial bundle
// every visitor downloads before they've clicked anything.
const LibraryHome = lazy(() => import("./pages/LibraryHome.js"));
const LibraryType = lazy(() => import("./pages/LibraryType.js"));
const LibraryUngrouped = lazy(() => import("./pages/LibraryUngrouped.js"));
const MediaDetail = lazy(() => import("./pages/MediaDetail.js"));
const EpisodeDetail = lazy(() => import("./pages/EpisodeDetail.js"));
const SubItemDetail = lazy(() => import("./pages/SubItemDetail.js"));
const TrackDetail = lazy(() => import("./pages/TrackDetail.js"));
const AddMedia = lazy(() => import("./pages/AddMedia.js"));
const Calendar = lazy(() => import("./pages/Calendar.js"));
const CalendarDay = lazy(() => import("./pages/CalendarDay.js"));
const Missing = lazy(() => import("./pages/Missing.js"));
const CutoffUnmet = lazy(() => import("./pages/CutoffUnmet.js"));
const HistoryPage = lazy(() => import("./pages/HistoryPage.js"));
const Blocklist = lazy(() => import("./pages/Blocklist.js"));
const Indexers = lazy(() => import("./pages/Indexers.js"));
const DownloadClients = lazy(() => import("./pages/DownloadClients.js"));
const IrcFeeds = lazy(() => import("./pages/IrcFeeds.js"));
const Settings = lazy(() => import("./pages/Settings.js"));
const Activity = lazy(() => import("./pages/Activity.js"));
const System = lazy(() => import("./pages/System.js"));
const GlobalSearch = lazy(() => import("./pages/GlobalSearch.js"));
const Collections = lazy(() => import("./pages/Collections.js"));
const CollectionDetail = lazy(() => import("./pages/CollectionDetail.js"));
const Requests = lazy(() => import("./pages/Requests.js"));
const Discover = lazy(() => import("./pages/Discover.js"));
const AiProviders = lazy(() => import("./pages/AiProviders.js"));
const CustomColumns = lazy(() => import("./pages/CustomColumns.js"));
const IptvPlaylists = lazy(() => import("./pages/IptvPlaylists.js"));
const Users = lazy(() => import("./pages/Users.js"));
const Recommendations = lazy(() => import("./pages/Recommendations.js"));
const AuditLog = lazy(() => import("./pages/AuditLog.js"));
const WatchlistImport = lazy(() => import("./pages/WatchlistImport.js"));
const ImportReview = lazy(() => import("./pages/ImportReview.js"));
const ApiDocs = lazy(() => import("./pages/ApiDocs.js"));
const Changelog = lazy(() => import("./pages/Changelog.js"));
const Person = lazy(() => import("./pages/Person.js"));
const RemoteLibrary = lazy(() => import("./pages/RemoteLibrary.js"));
const FriendLibraries = lazy(() => import("./pages/FriendLibraries.js"));
const ImportLists = lazy(() => import("./pages/ImportLists.js"));
const Account = lazy(() => import("./pages/Account.js"));
const Jobs = lazy(() => import("./pages/Jobs.js"));
const RecycleBin = lazy(() => import("./pages/RecycleBin.js"));
const Duplicates = lazy(() => import("./pages/Duplicates.js"));
const NetworkStats = lazy(() => import("./pages/NetworkStats.js"));
const MediaAnalyzer = lazy(() => import("./pages/MediaAnalyzer.js"));

/** Plain <BrowserRouter>/<Routes> (not the data-router API) never touches scroll position on
 * navigation on its own — this is what actually resets it back to the top of the new page. */
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function NavGroup({
  label,
  icon,
  defaultOpen,
  children,
}: {
  label: string;
  icon?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div>
      <a onClick={() => setOpen((o) => !o)} title={label} style={{ cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {icon}
          <span className="nav-label">{label}</span>
        </span>
        <span className="nav-label">{open ? "▾" : "▸"}</span>
      </a>
      {open && <div style={{ paddingLeft: 12 }}>{children}</div>}
    </div>
  );
}

interface NavLinkDef {
  to: string;
  label: string;
  end?: boolean;
  icon?: ReactNode;
}

/** Renders one link's icon + label — shared by the sidebar accordion, the icon-only collapsed
 * rail, and the topbar dropdown, so a link's `.nav-label` span is always in the same place for
 * styles.css's `.sidebar--collapsed .nav-label { display: none }` rule to hide. */
function NavLinkContent({ icon, label }: { icon?: ReactNode; label: string }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
      {icon}
      <span className="nav-label">{label}</span>
    </span>
  );
}

/** Sidebar rendering for one admin group: the existing expandable-accordion look. */
function SidebarGroup({ label, icon, links, defaultOpen }: { label: string; icon?: ReactNode; links: NavLinkDef[]; defaultOpen?: boolean }) {
  return (
    <NavGroup label={label} icon={icon} defaultOpen={defaultOpen}>
      {links.map((l) => (
        <NavLink key={l.to} to={l.to} end={l.end} title={l.label}>
          <NavLinkContent icon={l.icon} label={l.label} />
        </NavLink>
      ))}
    </NavGroup>
  );
}

/** Top-bar rendering for one admin group: a click-to-open dropdown instead of an inline
 * accordion, since a horizontal bar has no room to expand a section in place the way the
 * sidebar's vertical list does. */
function TopbarGroup({ label, icon, links }: { label: string; icon?: ReactNode; links: NavLinkDef[] }) {
  return (
    <DropdownMenu label={<NavLinkContent icon={icon} label={label} />} buttonClassName="topbar-trigger">
      {links.map((l) => (
        <NavLink key={l.to} to={l.to} end={l.end}>
          <NavLinkContent icon={l.icon} label={l.label} />
        </NavLink>
      ))}
    </DropdownMenu>
  );
}

export default function App() {
  const { auth, logout } = useAuth();
  const { pathname } = useLocation();
  const isAdmin = auth.isAdmin;
  const [showOnboarding, setShowOnboarding] = useState(false);
  const mediaTypes = useMediaTypes().filter((t) => isAdmin || auth.user?.allowedTypes.includes(t.key));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    const stored = localStorage.getItem("aonarr_sidebar_collapsed");
    if (stored !== null) return stored === "1";
    // No saved preference yet (first visit on this device) — default collapsed on a narrow/mobile
    // viewport, where the sidebar's fixed 220px would otherwise eat most of the screen. Desktop's
    // default (expanded) is unchanged; this only picks a different first-run default, it never
    // overrides a choice the user already made.
    return typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches;
  });
  const [customizingSidebar, setCustomizingSidebar] = useState(false);
  const [navPosition, setNavPosition] = useState<"side" | "top">(
    () => (localStorage.getItem("aonarr_nav_position") as "side" | "top") || "side"
  );

  useEffect(() => {
    localStorage.setItem("aonarr_sidebar_collapsed", sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);
  useEffect(() => {
    localStorage.setItem("aonarr_nav_position", navPosition);
  }, [navPosition]);

  useEffect(() => {
    if (!isAdmin) return;
    api
      .get<any[]>("/root-folders")
      .then((rows) => setShowOnboarding(shouldShowOnboarding(rows.length)))
      .catch(() => {});
  }, [isAdmin]);

  const libraryLinks: NavLinkDef[] = [
    { to: "/library", label: "Overview", end: true, icon: <FilmIcon /> },
    ...mediaTypes.map((t) => ({ to: `/library/${t.key}`, label: t.label, icon: <FilmIcon /> })),
  ];
  // Search is rendered as its own hardcoded link (like Dashboard) rather than living in this array,
  // since it belongs between Dashboard and Library in the fixed top-level order — everything else
  // that isn't Library renders after Library, so it can't get there through this array alone.
  // Admins reach Discover/Requests through the "Manage" group below; household accounts have no
  // such group at all, so without these they'd have no way to reach either page short of typing
  // the URL by hand — Requests.tsx already renders a full submission form for them, it just had no
  // nav link pointing at it before Discover made that gap obvious.
  const standaloneLinks: NavLinkDef[] = isAdmin
    ? [{ to: "/account", label: "Account", icon: <UserIcon /> }]
    : [
        { to: "/discover", label: "Discover", icon: <CompassIcon /> },
        { to: "/requests", label: "Requests", icon: <InboxIcon /> },
        { to: "/account", label: "Account", icon: <UserIcon /> },
      ];

  // Only the admin-only section groups are reorderable — Library stays pinned right after
  // Dashboard since every account (including household logins) relies on it being there, and
  // reordering/hiding it would just be a way to accidentally lose your own library nav. Plain
  // link data rather than pre-rendered JSX, since the sidebar and top-bar layouts render the same
  // groups two different ways (an accordion vs. a dropdown) — see SidebarGroup/TopbarGroup above.
  const adminGroupDefs: { key: string; label: string; icon: ReactNode; links: NavLinkDef[] }[] = [
    {
      key: "manage",
      label: "Manage",
      icon: <ListIcon />,
      links: [
        { to: "/add", label: "Add Media", icon: <PlusCircleIcon /> },
        { to: "/activity", label: "Activity", icon: <ActivityIcon /> },
        { to: "/calendar", label: "Calendar", icon: <CalendarIcon /> },
        { to: "/collections", label: "Collections", icon: <LayersIcon /> },
        { to: "/discover", label: "Discover", icon: <CompassIcon /> },
        { to: "/iptv-playlists", label: "IPTV Playlists", icon: <RadioIcon /> },
        { to: "/import-lists", label: "Import Lists", icon: <ListIcon /> },
        { to: "/import-review", label: "Import Review", icon: <CheckSquareIcon /> },
        { to: "/missing", label: "Missing", icon: <AlertTriangleIcon /> },
        { to: "/cutoff-unmet", label: "Cutoff Unmet", icon: <ArrowUpCircleIcon /> },
        { to: "/recommendations", label: "Recommendations", icon: <StarIcon /> },
        { to: "/requests", label: "Requests", icon: <InboxIcon /> },
        { to: "/watchlist-import", label: "Watchlist Import", icon: <DownloadIcon /> },
      ].sort((a, b) => a.label.localeCompare(b.label)),
    },
    {
      key: "configuration",
      label: "Configuration",
      icon: <SlidersIcon />,
      links: [
        { to: "/ai-providers", label: "AI Providers", icon: <CpuIcon /> },
        { to: "/custom-columns", label: "Custom Columns", icon: <ColumnsIcon /> },
        { to: "/download-clients", label: "Download Clients", icon: <HardDriveIcon /> },
        { to: "/indexers", label: "Indexers", icon: <ZapIcon /> },
        { to: "/irc-feeds", label: "IRC Announce Feeds", icon: <MessageCircleIcon /> },
        { to: "/settings", label: "Settings", icon: <SlidersIcon /> },
        { to: "/users", label: "Users", icon: <UsersIcon /> },
      ].sort((a, b) => a.label.localeCompare(b.label)),
    },
    {
      key: "system",
      label: "System",
      icon: <ServerIcon />,
      links: [
        { to: "/api-docs", label: "API Docs", icon: <CodeIcon /> },
        { to: "/audit-log", label: "Audit Log", icon: <ShieldIcon /> },
        { to: "/blocklist", label: "Blocklist", icon: <SlashIcon /> },
        { to: "/duplicates", label: "Duplicates", icon: <CopyIcon /> },
        { to: "/history", label: "History", icon: <ClockIcon /> },
        { to: "/friend-libraries", label: "Friend Libraries", icon: <ShareIcon /> },
        { to: "/jobs", label: "Jobs", icon: <BriefcaseIcon /> },
        { to: "/media-analyzer", label: "Media Analyzer", icon: <BarChartIcon /> },
        { to: "/network-stats", label: "Network Stats", icon: <WifiIcon /> },
        { to: "/recycle-bin", label: "Recycle Bin", icon: <RotateCcwIcon /> },
        { to: "/remote-library", label: "Remote Library", icon: <GlobeIcon /> },
        { to: "/system", label: "Status & Health", icon: <ServerIcon /> },
        { to: "/changelog", label: "What's New", icon: <BellIcon /> },
      ].sort((a, b) => a.label.localeCompare(b.label)),
    },
  ];
  const { orderedItems: orderedGroups, visibleItems: visibleGroups, hidden: hiddenGroups, moveUp: moveGroupUp, moveDown: moveGroupDown, toggleHidden: toggleGroupHidden } =
    useCustomizableLayout(
      "aonarr_sidebar_groups",
      adminGroupDefs.map((g) => ({ key: g.key, label: g.label }))
    );
  const groupByKey = new Map(adminGroupDefs.map((g) => [g.key, g]));
  const isMobile = typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches;

  const customizePanel = (
    <div style={{ padding: navPosition === "side" ? "4px 20px 8px" : "8px 4px" }}>
      {orderedGroups.map((item, idx) => (
        <div key={item.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0", gap: 12 }}>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              margin: 0,
              fontSize: "0.8rem",
              color: hiddenGroups.has(item.key) ? "var(--muted)" : "var(--text)",
            }}
          >
            <input type="checkbox" checked={!hiddenGroups.has(item.key)} onChange={() => toggleGroupHidden(item.key)} />
            {item.label}
          </label>
          <div style={{ display: "flex", gap: 2 }}>
            <button
              type="button"
              className="secondary"
              onClick={() => moveGroupUp(item.key)}
              disabled={idx === 0}
              aria-label={`Move ${item.label} up`}
              style={{ padding: "1px 7px", margin: 0, fontSize: "0.75rem" }}
            >
              ↑
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => moveGroupDown(item.key)}
              disabled={idx === orderedGroups.length - 1}
              aria-label={`Move ${item.label} down`}
              style={{ padding: "1px 7px", margin: 0, fontSize: "0.75rem" }}
            >
              ↓
            </button>
          </div>
        </div>
      ))}
      <label style={{ display: "flex", alignItems: "center", gap: 6, margin: "8px 0 0", fontSize: "0.8rem" }}>
        Nav position:
        <select
          value={navPosition}
          onChange={(e) => setNavPosition(e.target.value as "side" | "top")}
          style={{ width: "auto", height: 26, padding: "0 22px 0 6px", fontSize: "0.8rem" }}
        >
          <option value="side">Sidebar</option>
          <option value="top">Top bar</option>
        </select>
      </label>
    </div>
  );

  return (
    <div className={navPosition === "top" ? "app app--top" : "app"}>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <ScrollToTop />
      <CommandPalette />

      {navPosition === "side" && (
        <>
          {/* Mobile-only affordance: on mobile "collapsed" means the sidebar is fully absent (see
              the nav's own style below), so this floating button is the only way back to it. On
              desktop, "collapsed" instead renders the icon-only rail itself, which carries its own
              ☰ toggle in .brand — this button has nothing left to do there and stays hidden. */}
          <button
            type="button"
            className="secondary"
            onClick={() => setSidebarCollapsed((v) => !v)}
            title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            style={{
              position: "fixed",
              top: 12,
              left: 12,
              zIndex: 30,
              padding: 0,
              margin: 0,
              width: 40,
              height: 40,
              fontSize: "1.1rem",
              display: sidebarCollapsed && isMobile ? "flex" : "none",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            ☰
          </button>
          {/* On a narrow viewport the sidebar sits above content as a full-width overlay while
              expanded (rather than squeezing content into the leftover ~150px next to a fixed
              220px column) — dismissed the same way it's opened, via the ☰ toggle. On desktop,
              collapsed renders as a Sonarr-style icon-only rail (`.sidebar--collapsed`, styles.css)
              instead of disappearing outright. */}
          <nav
            className={`sidebar${sidebarCollapsed && !isMobile ? " sidebar--collapsed" : ""}`}
            style={
              sidebarCollapsed && isMobile
                ? { display: "none" }
                : !sidebarCollapsed && isMobile
                  ? { position: "fixed", inset: 0, width: "100%", zIndex: 25, overflowY: "auto" }
                  : undefined
            }
          >
            <div className="brand" style={{ justifyContent: "space-between" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <img src="/icon.svg" alt="" width={28} height={28} />
                <span className="nav-label">AoNarr</span>
              </span>
              <button
                type="button"
                className="secondary"
                onClick={() => setSidebarCollapsed((v) => !v)}
                title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
                style={{ padding: "2px 8px", margin: 0, fontSize: "0.8rem" }}
              >
                ☰
              </button>
            </div>
            <div className="sidebar-hint" style={{ fontSize: "0.7rem", color: "var(--muted)", padding: "0 12px 8px" }} title="Ctrl/Cmd+K to jump anywhere, / to search">
              ⌘K to jump · / to search
            </div>
            <NavLink to="/" end title="Dashboard">
              <NavLinkContent icon={<HomeIcon />} label="Dashboard" />
            </NavLink>
            <NavLink to="/search" title="Search">
              <NavLinkContent icon={<SearchIcon />} label="Search" />
            </NavLink>

            <SidebarGroup label="Library" icon={<FilmIcon />} links={libraryLinks} defaultOpen />

            {standaloneLinks.map((l) => (
              <NavLink key={l.to} to={l.to} title={l.label}>
                <NavLinkContent icon={l.icon} label={l.label} />
              </NavLink>
            ))}

            {isAdmin && visibleGroups.map((g) => <SidebarGroup key={g.key} label={g.label} icon={groupByKey.get(g.key)?.icon} links={groupByKey.get(g.key)?.links ?? []} />)}

            {isAdmin && (
              <div className="sidebar-customize">
                <a onClick={() => setCustomizingSidebar((v) => !v)} style={{ cursor: "pointer", fontSize: "0.85rem" }}>
                  {customizingSidebar ? "Done customizing" : "Customize sections..."}
                </a>
                {customizingSidebar && customizePanel}
              </div>
            )}

            <div className="sidebar-footer" style={{ marginTop: "auto", display: "flex", flexDirection: "column" }}>
              <ThemeToggle />
              <LayoutWidthToggle />
              <NotificationsToggle />
              <a onClick={logout} style={{ cursor: "pointer" }}>
                Log out
              </a>
            </div>
          </nav>
        </>
      )}

      {navPosition === "top" && (
        <header className="topbar">
          <span className="brand">
            <img src="/icon.svg" alt="" width={24} height={24} />
            AoNarr
          </span>
          <NavLink to="/" end>
            <NavLinkContent icon={<HomeIcon />} label="Dashboard" />
          </NavLink>
          <NavLink to="/search">
            <NavLinkContent icon={<SearchIcon />} label="Search" />
          </NavLink>
          <TopbarGroup label="Library" icon={<FilmIcon />} links={libraryLinks} />
          {standaloneLinks.map((l) => (
            <NavLink key={l.to} to={l.to}>
              <NavLinkContent icon={l.icon} label={l.label} />
            </NavLink>
          ))}
          {isAdmin && visibleGroups.map((g) => <TopbarGroup key={g.key} label={g.label} icon={groupByKey.get(g.key)?.icon} links={groupByKey.get(g.key)?.links ?? []} />)}
          <div className="topbar-spacer" style={{ position: "relative" }}>
            {isAdmin && (
              <>
                <button type="button" className="secondary" onClick={() => setCustomizingSidebar((v) => !v)} title="Layout options">
                  ⚙
                </button>
                {customizingSidebar && (
                  <div className="dropdown-menu" style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, left: "auto", minWidth: 260 }}>
                    {customizePanel}
                  </div>
                )}
              </>
            )}
            <ThemeToggle />
            <LayoutWidthToggle />
            <NotificationsToggle />
            <a onClick={logout} style={{ cursor: "pointer" }}>
              Log out
            </a>
          </div>
        </header>
      )}

      <main className="content" id="main-content" tabIndex={-1}>
        <Suspense fallback={<div className="muted">Loading…</div>}>
        <Routes>
          <Route
            path="/"
            element={
              isAdmin && showOnboarding ? <Onboarding onDone={() => setShowOnboarding(false)} /> : <Dashboard />
            }
          />
          <Route path="/library" element={<LibraryHome />} />
          <Route path="/library/:type" element={<LibraryType />} />
          <Route path="/library/:type/g/:groupId" element={<LibraryType />} />
          <Route path="/library/:type/ungrouped" element={<LibraryUngrouped />} />
          <Route path="/media/:id" element={<MediaDetail />} />
          <Route path="/media/:mediaId/episode/:episodeId" element={<EpisodeDetail />} />
          <Route path="/media/:mediaId/item/:subItemId" element={<SubItemDetail />} />
          <Route path="/media/:mediaId/item/:subItemId/track/:trackId" element={<TrackDetail />} />
          <Route path="/people/:tmdbId" element={<Person />} />
          <Route path="/search" element={<GlobalSearch />} />
          <Route path="/collections" element={<Collections />} />
          <Route path="/collections/:id" element={<CollectionDetail />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/discover" element={<Discover />} />
          {isAdmin && <Route path="/ai-providers" element={<AiProviders />} />}
          {isAdmin && <Route path="/custom-columns" element={<CustomColumns />} />}
          {isAdmin && <Route path="/iptv-playlists" element={<IptvPlaylists />} />}
          <Route path="/changelog" element={<Changelog />} />
          <Route path="/account" element={<Account />} />
          {isAdmin && <Route path="/add" element={<AddMedia />} />}
          {isAdmin && <Route path="/recommendations" element={<Recommendations />} />}
          {isAdmin && <Route path="/watchlist-import" element={<WatchlistImport />} />}
          {isAdmin && <Route path="/import-review" element={<ImportReview />} />}
          {isAdmin && <Route path="/import-lists" element={<ImportLists />} />}
          {isAdmin && <Route path="/calendar" element={<Calendar />} />}
          {isAdmin && <Route path="/calendar/:date" element={<CalendarDay />} />}
          {isAdmin && <Route path="/missing" element={<Missing />} />}
          {isAdmin && <Route path="/cutoff-unmet" element={<CutoffUnmet />} />}
          {isAdmin && <Route path="/history" element={<HistoryPage />} />}
          {isAdmin && <Route path="/blocklist" element={<Blocklist />} />}
          {isAdmin && <Route path="/activity" element={<Activity />} />}
          {isAdmin && <Route path="/indexers" element={<Indexers />} />}
          {isAdmin && <Route path="/download-clients" element={<DownloadClients />} />}
          {isAdmin && <Route path="/irc-feeds" element={<IrcFeeds />} />}
          {isAdmin && <Route path="/users" element={<Users />} />}
          {isAdmin && <Route path="/audit-log" element={<AuditLog />} />}
          {isAdmin && <Route path="/settings" element={<Settings />} />}
          {isAdmin && <Route path="/system" element={<System />} />}
          {isAdmin && <Route path="/jobs" element={<Jobs />} />}
          {isAdmin && <Route path="/recycle-bin" element={<RecycleBin />} />}
          {isAdmin && <Route path="/duplicates" element={<Duplicates />} />}
          {isAdmin && <Route path="/network-stats" element={<NetworkStats />} />}
          {isAdmin && <Route path="/media-analyzer" element={<MediaAnalyzer />} />}
          {isAdmin && <Route path="/api-docs" element={<ApiDocs />} />}
          {isAdmin && <Route path="/remote-library" element={<RemoteLibrary />} />}
          {isAdmin && <Route path="/friend-libraries" element={<FriendLibraries />} />}
          {/* Catches a mistyped/bookmarked URL and, since an admin-only Route above isn't even
              registered for a non-admin, a household account following a link to one — both
              otherwise rendered a blank content area next to a normal-looking sidebar. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </main>
    </div>
  );
}
