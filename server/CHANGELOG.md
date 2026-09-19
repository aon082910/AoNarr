# Changelog

All notable changes to AoNarr, newest first. See README.md's Verification section for the full
build/test log behind each round.

## Round 312 — Media Analyzer: live progress, search-for-upgrade, pagination/CSV export, and a real language/resolution dedup bug
Three requested improvements plus a real bug fix to the same page.

**Duplicate resolution/language buckets, fixed.** The Resolution/Subtitle languages/Spoken
languages summary tables grouped by the raw, unnormalized values — a language tag could be
2-letter ("en"), 3-letter ("eng"), or either the bibliographic or terminology ISO 639-2 form
("ger"/"deu", "fre"/"fra", "chi"/"zho" — muxers aren't consistent), so the same actual language
showed up as 2-3 separate rows; resolution grouped by exact `WxH` ("1920x1080" vs. a cinematically
-cropped "1920x804" of the same 1080p source) for the same reason. Fixed with two new pure
functions in `services/mediaAnalysis.ts`: `normalizeLanguage()` (uses `Intl.DisplayNames`, built
into Node/every browser — no new dependency — to resolve any of those forms to one canonical name,
falling back to the raw code only when it's genuinely unrecognized) and `resolutionTier()`
(classifies into the same named tiers the rest of the app already uses for the quality ladder and
release-name parsing — 480p/576p/720p/1080p/2160p — by the *longer* edge, since a cinematic crop
shrinks height, not width). Audio/subtitle tracks with no language tag at all now bucket as an
explicit "Unknown" instead of being silently omitted. Both functions are duplicated client-side
(same technique already used for `clampLimit`/`csvEscape`-style small utils) so a stat-table click
still matches the same items it's grouping. New tests cover the exact "en"+"eng" and letterboxed
-1080p dedup cases directly, and the one pre-existing test that asserted the old raw-string
behavior is updated to the new (correct) grouping.

**Live analysis progress**, replacing the old fire-and-forget "click Analyze Now, then go check
the Logs page" experience: `runLibraryAnalysis()` now maintains a module-level progress state
(`{running, total, done, failed}`) polled every 1.2s by a new `GET /media-analysis/progress`
endpoint, rendered as a live progress bar with a running "N of M probed" count. `POST /run` now
refuses to start a second run while one is already in flight (`{started:false, reason:
"already-running"}`) instead of letting two overlapping probes race each other. Loading the page
while a run is already active (e.g. started from another tab) picks up its progress immediately
rather than only ever noticing a run this page itself started.

**"Search for a better release"**, reusing the exact same `POST /search/bulk` automated search
-and-grab endpoint Cutoff Unmet already uses for this identical "found something suboptimal, try
to upgrade it" case — per-row and bulk (checkbox selection + "Search all currently shown,"
respecting whatever filters are active) actions, chunked into batches of 100 to respect that
endpoint's per-request cap regardless of how many rows are selected.

**Pagination and CSV export**, matching every other list page's now-standard pattern. Since the
whole analysis result is already fetched in one (fast, ffprobe-free — it only reads already-stored
`media_info`) request, pagination here windows the already-loaded, already-filtered array
client-side via the shared `Pagination` component rather than adding new server round-trips.
"Export CSV" hits a new `GET /media-analysis/export.csv` endpoint (matching `/api/media/export.csv`'s
existing convention) with one row per analyzed file — title, path, codec, resolution tier, HDR,
audio/subtitle languages, and compatibility notes.

Verified: `npx tsc --noEmit` clean in both projects; the full server test suite (89 files, 1377
tests, including 20 new tests for `normalizeLanguage`/`resolutionTier`/the dedup regression) passes
in a disposable Linux container. Live-verified against the real server with inserted fixture files
covering "en" vs. "eng" vs. "fre" vs. "fra" audio tracks and a letterboxed-1080p file — confirmed
they collapse into single "English"/"French"/"1080p" buckets and that clicking a bucket still
finds the same items; ran a real analysis pass and confirmed the progress bar's poll-and-detect
-completion cycle end to end (including the already-running guard); confirmed bulk search-selected,
"Select all on this page", and CSV export (checked the actual response body) all work with no
console errors.

## Round 311 — toolbar alignment fix, a real "Downloaded" status bug, and pagination for six more pages
Three separate fixes/additions from user-reported issues.

**Toolbar alignment.** `.toolbar-group` (the new `PageToolbar`'s left/right containers from Round
310) never got the height-normalization rules `.toolbar` has always had for its own button/select/
input/dropdown children — so a `DropdownMenu` trigger (View mode, Columns, ...) sitting in a
`PageToolbar`'s right-hand group rendered ~15-20px taller than the plain `<select>`s next to it,
inheriting the base `button` rule's `margin-top: 16px`/`padding: 8px 16px` unreset. Fixed by adding
the same `.toolbar-group > select/input { height: 38px }` and `.toolbar-group > .dropdown > button
{ height: 38px }` reset `.toolbar` already had — a pure CSS fix, affects every page using
`PageToolbar` at once.

**"Downloaded" status was wrong for partially-downloaded TV shows and Music.** For episodic
(series/anime/sports) and collection (music/books/comics/...) shapes, a media item's own `has_file`
only ever meant "at least one episode/track has a file" (see `services/childCounts.ts`) — but
`LibraryType.tsx`'s status badge/poster-banner and the server's `status=downloaded`/`status=missing`
library filter (`services/mediaQuery.ts`) both checked that flag directly, so a series with 1 of 10
episodes downloaded showed "Downloaded" and could never match a "Missing" filter. Fixed on both
sides: `posterBanner()` now uses the already-fetched `childCount`/`childHaveCount` to show
"Downloaded" (all children present), a new neutral "Partial" state (some present — new
`.poster-banner.partial`/`.pill.partial`, reusing `var(--muted)`, no new colors), or "Missing" (none)
for those two shapes; the server's status filter now requires ALL episodes/tracks present for
`downloaded` and treats anything short of that as `missing`, via new `typeKeysByShape()` (derived
from `MEDIA_TYPES`, not hardcoded) and a `downloadStatusCondition()` helper in `mediaQuery.ts`.
Single-file shapes (movies, ROMs, ...) are unaffected — this only changes behavior for shapes with
children. Added a real regression test (`mediaQuery.test.ts`) covering fully/partially/never
downloaded series, replacing an old test that asserted the exact literal SQL string.

**Pagination for six more list pages**, matching the page-size dropdown (30/60/100/250) + "Page X
of Y (N total)" + Prev/Next pattern `LibraryType.tsx` and `AuditLog.tsx` already used — extracted
into a new shared `web/src/components/Pagination.tsx` component (both of those now use it too,
replacing their own hand-rolled copies) and reusing `mediaQuery.ts`'s existing `clampLimit`/
`clampOffset` helpers server-side. Added real server-side `limit`/`offset` (previously: no limit at
all, or a hardcoded window with no way to page further) to: `Activity.tsx`'s Queue and History
sections and the standalone `HistoryPage.tsx` (all three backed by `routes/activity.ts` — the
History section's old fixed top-200 merge-and-slice and `HistoryPage`'s hard 500-row cap are both
gone, replaced by real paging), `Blocklist.tsx`, `CutoffUnmet.tsx` (paginated over the resolved
candidate-id array, since `findUpgradeCandidates()` has no SQL WHERE to attach a COUNT to), and
`ImportReview.tsx` and `Requests.tsx`. Every affected endpoint's response shape changed from a bare
array to `{ items, total }` (or `{ rows, total, page, pageSize, totalPages }` for `cutoff-unmet`,
matching `audit-log`'s existing shape) — updated the one other caller this broke
(`server/src/mcp/server.ts`'s `get_queue` tool, now requests `?limit=500` and unwraps `items` to
keep returning a plain array) and a second one missed by the first pass (`Settings.tsx`'s Blocklist
tile, which fetched `/blocklist` independently of the dedicated page and needed the same unwrap).
A "select all visible"/bulk-selection feature on a paginated list now naturally scopes to the
current page's loaded rows, matching how `LibraryType.tsx`'s own bulk-select already worked — not a
regression, the expected behavior once paging exists.

Deliberately NOT paginated, each for a specific reason (flagging so these aren't mistaken for
oversights): `Missing.tsx`'s episode section and `RecycleBin.tsx` group their rows into collapsible
per-series/per-type sections — naive row-level pagination would break that UX, and doing it right
needs group-aware pagination on the server, a bigger, separate change. `Duplicates.tsx` computes
its (typically small) result via a full in-memory scan/group rather than a single filtered SQL
query, so `LIMIT`/`OFFSET` doesn't attach cleanly. `Collections.tsx` is admin-curated and stays
small in practice, not library-scaled. `WatchlistImport.tsx` renders the one-shot result of a
single POST (already capped at 500 rows), not a persisted, growable list with a GET endpoint to
paginate.

Verified: `npx tsc --noEmit` clean in both `web/` and `server/`; the full server test suite (89
files, 1367 tests, run in a disposable Linux container per this repo's usual native-binary-on-
Windows workaround) passes, including the new regression test. Live-verified against the real
`aonarr-server`/`aonarr-web-dev` stack with temporary DB fixtures (inserted, checked, deleted) for
every one of the six newly-paginated pages/sections plus the two fixed status-badge/toolbar issues
and both broken callers' fixes — no console errors on any of them.

## Round 310 — Starr-style page toolbars, detail-page pills, and popup-ified forms across the app
Layout-and-placement pass matching how Sonarr/Radarr/Lidarr/Readarr/Whisparr actually organize a
page — verified against Sonarr's own frontend source (GitHub), not guessed. Colors are completely
unchanged; the sidebar/topbar toggle and the centered/full-width layout toggle both work exactly
as before (neither was touched).

Two new shared pieces: `web/src/components/PageToolbar.tsx` (`PageToolbar`, `ToolbarButton` —
icon-over-label, for page-level actions — and `ToolbarSeparator`) and a handful of new CSS classes
in `styles.css` (`.page-toolbar`, `.toolbar-group`, `.toolbar-button`, `.detail-pills`/`.pill`,
`.spin`), plus five new icons in `ActionIcons.tsx` (`RowsIcon`, `TableIcon`, `FilterIcon`,
`SortIcon`, `RefreshIcon`). `.page-toolbar` bleeds to the edges of `.content` the same way
`.media-backdrop` already does, so it automatically respects the layout-width preference. The
existing icon-only `.icon-button` convention (Round 305) is untouched and still owns every
per-row/in-context action (a table row's Search/Delete icon, a card's remove icon) — the new
labeled `ToolbarButton` is only for the page-level toolbar bar.

Rolled out across every admin page with a real page-level action (29 page files): library list
pages consolidated their two stacked ad hoc toolbars into one left/right `PageToolbar`; every
detail page (`MediaDetail`, `EpisodeDetail`, `SubItemDetail`, `TrackDetail`, `AddPreview`) moved
its action-icon row above the poster/backdrop hero (previously it sat awkwardly mid-page) and
replaced the inline paragraph-of-badges-and-a-table with a proper `.detail-pills` fact row;
`MediaDetail`'s five inline toggle-panels (Edit Metadata, History, Move to Group, Split, Artwork)
are now real `Modal` dialogs instead of inline divs, and its two genuinely-editable fields
(Minimum availability, Series type) moved into the Edit Metadata modal alongside title/year/
overview/poster/backdrop, with a read-only pill showing the current value on the page itself.
Several pages that used an always-visible inline form for their one "create X" action (Collections,
ImportLists, Requests' non-admin submission form) now use an Add-button-opens-Modal pattern
matching Indexers.tsx, which was built first as the reference implementation every other agent
worked from. Pages with no real page-level action (Person, RecycleBin, AuditLog, ApiDocs,
Changelog, NetworkStats, and others) were deliberately left alone rather than growing an invented
toolbar with nothing meaningful in it.

Verified live against the real running `aonarr-web-dev`/`aonarr-server` containers: the reference
page (Indexers) and the two highest-risk conversions (`LibraryType`'s consolidated toolbar,
`MediaDetail`'s full hero/toolbar/modal rework, including opening the new Edit Metadata modal and
confirming Minimum availability still saves) both in top-bar and collapsed-sidebar layouts, plus
Collections' new Add-modal and Activity's nested toolbar buttons. Caught and fixed one real bug in
review: `.toolbar-button.danger` didn't reset `background`, so the pre-existing global
`button.danger { background: var(--danger) }` rule (matched by class alone, regardless of a
button's other classes) painted a solid red block over the Remove button's icon and label instead
of the intended transparent-until-hover treatment — fixed by explicitly setting
`background: transparent` on the danger variant. `npx tsc --noEmit` and `npm run build` both pass
clean across the whole `web/` project.

A few deliberate scope boundaries, all noted so they aren't mistaken for oversights: `Settings.tsx`
and `System.tsx` (large, tab-based pages) had their header/tab-bar placement confirmed already
correct and were left otherwise untouched — restyling their tab *content* would be a much bigger,
separate effort. `AddMedia.tsx`'s search/lookup step keeps its existing segmented type/provider
picker as-is (an in-form tab switcher, not a page-level action row). A small, known inconsistency:
the read-only "Downloaded/Missing" status fact renders as the original colored `.badge ok/danger`
in some pages and stays that way deliberately (`.pill` has no green success variant), which is a
reasonable follow-up if a future round wants to add one.

## Round 309 — the last native popup: window.prompt() replaced too
Closes the one gap Round 308 deliberately left open. New `web/src/utils/promptDialog.ts` +
`web/src/components/PromptModal.tsx` (same architecture as `confirmDialog`/`ConfirmModal`: a
promise-based singleton, mounted once in `App.tsx`, built on the shared `Modal.tsx` shell) replace
every `window.prompt()` in the app — `promptDialog({title, label, defaultValue?}): Promise<string |
null>` for a single field (same null-vs-string contract `prompt()` itself has), or pass `fields:
[...]` for more than one, resolving `Record<string, string> | null` instead.

Two sites used to chain two `prompt()` calls to fake a multi-field form — both now show a single
dialog with both fields together instead: `SubItemDetail.tsx`'s series editor (name + position,
position only meaningful when name is set) and `GroupPicker.tsx`'s "+ New" group creation (name,
plus a website field shown only for a "site"-kind group). The other 7 sites (`LibraryType.tsx` ×3,
`MediaDetail.tsx` ×2 — including the Share-link clipboard-copy fallback, which was never really
collecting new input, just using `prompt()` as a copy-paste field — and `SubItemDetail.tsx` ×2)
convert 1:1.

Verified live: the single-field case (`LibraryType.tsx`'s "Save view", including cleanup via the
also-newly-converted "Delete view" confirm), the two-field case (`SubItemDetail.tsx`'s series
editor, against the same sub-item fixture used in earlier rounds — reverted after), and the
conditional-field case (`GroupPicker.tsx`'s "+ New Site" showing both Name and Website, versus a
plain kind showing just Name). One finding worth remembering, not a real bug: a synthetic Enter
keypress from browser automation didn't trigger the form's implicit submission even though focus
and the DOM were verified correct — calling `form.requestSubmit()` directly confirmed the wiring
was right all along; this is an automation-layer quirk, not an app bug, and real keyboard input in
a real browser is unaffected.

Every native browser popup (`alert`, `confirm`, `prompt`) is now gone from the app.

## Round 308 — popup rollout complete: LibraryType, MediaDetail, Settings
Finishes the `alert()`/`confirm()` → `notify`/`confirmDialog` conversion started in Round 306 —
**every native browser popup in the app is now gone**, across all three of the largest remaining
files (`LibraryType.tsx`, `MediaDetail.tsx` — the biggest file in the app, `Settings.tsx`), on top
of their checkbox-chain functions already converted in Round 306. ~45 more call sites, all the
same established patterns: error/success/info toasts, and plain yes/no confirms for token/API-key/
webhook-URL regeneration, group/saved-view deletion, root-folder moves, and a blocklist release.
One post-action navigation choice (`MediaDetail.tsx`'s split-item "go to the new show now?") uses
`confirmDialog` with custom `confirmLabel`/`cancelLabel` ("Go to new show"/"Stay here") instead of
generic Confirm/Cancel, since it isn't a safety gate — the split already happened, this is just
picking where to go next.

`window.prompt()` (a handful of free-text inputs — `SubItemDetail.tsx`/`MediaDetail.tsx`'s cover-
art/series/narrator editors, `GroupPicker.tsx`'s "+ New" group creation, `MediaDetail.tsx`'s Share-
link clipboard-copy fallback) is deliberately left alone — a different native-popup category
(text input, not alert/confirm) that would need its own new modal component, not built as part of
this effort.

Verified live: `Settings.tsx`'s "Regenerate API key" confirm dialog rendered and cancelled cleanly;
`LibraryType.tsx` and `MediaDetail.tsx` both load without any new console errors after their edits.
A final app-wide grep (`grep -rn "alert(\|confirm(" web/src/pages web/src/components`) turned up
only doc-comment mentions of the old behavior — no real call sites left.

## Round 307 — popup rollout continues: Activity, IptvPlaylists, System, SubItemDetail
Continues Round 306's `alert()`/`confirm()` → `notify`/`confirmDialog` conversion. All four files
are now fully converted (44 combined call sites: `Activity.tsx` 5, `IptvPlaylists.tsx` 10+1,
`System.tsx` 9+3, `SubItemDetail.tsx` 16+2) — all straightforward error/success/info toasts and
plain yes/no confirms, no new multi-checkbox chains found (`System.tsx`'s restore-backup and
rename-files confirms were each already a single question, not a chain, despite being high-stakes
enough to double-check for one).

Fixed a real gap the conversion surfaced: `.toast-message` had no `white-space: pre-line`, so a
multi-line message (e.g. `System.tsx`'s "N item(s) failed to delete:\n<list>") would have silently
collapsed onto one line instead of showing each failure separately — `ConfirmModal.tsx`'s message
paragraph already had this, the toast just hadn't needed it until this batch.

Verified live: `System.tsx`'s Trakt sync produced a real `.toast.success` ("Trakt sync added 0 new
item(s)."), confirmed via the DOM (a fast robot click checks the DOM before React's batched state
update flushes — a ~1s wait was needed to see it, worth remembering for future toast checks so a
timing artifact doesn't get mistaken for a real bug). `SubItemDetail.tsx`'s "Mark as missing"
confirm dialog rendered correctly against a temporary sub-item fixture (has_file flipped to 1 and
back after). Remaining large files (`LibraryType`, `MediaDetail`, `Settings` — each has real
alert/confirm sites beyond the checkbox-chain function already converted in Round 306) continue
next.

## Round 306 — Servarr-style popups (toast + confirm dialog) + Add Media redesign
Two related pieces of new infrastructure, plus a first rollout batch of each.

**Toast notifications and a confirmation dialog, replacing the browser's native `alert()`/
`confirm()`.** New `web/src/utils/notify.ts` (`notify.success/error/info(message)`, a tiny
pub-sub any file can call directly) + `web/src/components/Toaster.tsx` (stacked, auto-dismissing,
top-right, new slide-in `@keyframes` in `styles.css` — the first animation in the app). New
`web/src/utils/confirmDialog.ts` (`confirmDialog({title, message, danger?}): Promise<boolean>`,
or pass `options: [{key, label}]` for a richer Sonarr/Radarr-style checkbox dialog, resolving
`{confirmed, values} | null` instead) + `web/src/components/ConfirmModal.tsx`, a thin wrapper
around the existing `Modal.tsx` shell (reuses its focus trap/Escape/stacking for free). Both are
mounted once in `App.tsx`, next to the existing `CommandPalette`.

Three multi-`confirm()`-chain call sites — each used to simulate a 2-3-way choice by stacking
native confirms, since a single native dialog can't have checkboxes — now use one `confirmDialog`
call with `options` instead, matching how Sonarr/Radarr's own delete dialogs actually look:
`LibraryType.tsx`'s bulk delete (delete files? add exclusion?), `MediaDetail.tsx`'s remove-item
(same two questions — previously an awkward "Cancel this dialog, then OK the next one" dance to
fake a third option, now just an unchecked checkbox), and `Settings.tsx`'s root-folder delete
(remove media too? delete their files too?). The duplicate-add retry shape (`if (confirm(x)) {
retry(true) }`, found in `AddMedia`→now `AddPreview`, `Discover.tsx`, `Requests.tsx` ×2) uses the
plain boolean form.

Every `alert()`/`confirm()` in `Blocklist`, `Calendar`, `CalendarDay`, `CollectionDetail`,
`Collections`, `CutoffUnmet`, `DownloadClients`, `GlobalSearch`, `Indexers`, `IrcFeeds`, `Jobs`,
`MediaAnalyzer`, `Missing`, `Recommendations`, `RecycleBin`, `Users`, `WatchlistImport`,
`Discover`, `Requests`, `ImportReview`, `Duplicates`, `EpisodeDetail`, and the components
`NamingSetupModal`/`NotificationsToggle` is now converted (~24 files). The remaining large files
(`Activity`, `IptvPlaylists`, `System`, and the rest of `LibraryType`/`MediaDetail`/`Settings`/
`SubItemDetail` beyond the checkbox chains already done) continue in follow-up rounds, same
incremental rhythm as the icon-button rollout. `window.prompt()` (a few free-text inputs in
`SubItemDetail.tsx`/`GroupPicker.tsx`) is a separate, smaller residual native-popup category not
covered by this round.

**Add Media now previews like a real detail page before creating anything**, matching Sonarr/
Radarr's "Add New Series/Movie" convention. New `web/src/pages/AddPreview.tsx` (routed at
`/add/preview`) renders a `MediaDetail.tsx`-style hero (same `.media-backdrop` CSS, poster, title,
overview — deliberately reimplemented rather than extracted from `MediaDetail.tsx`, since a
pre-add item has no numeric id yet for the real page's cast/ratings/trailer/file-status sections
to key off, and extracting a shared component would mean threading "is this real or a preview"
conditionals through the largest file in the app for ~100 lines saved) below which the actual
root-folder/quality-profile/monitor-strategy/group-picker configuration and "Add to library"
button live. It's reached via React Router navigation state — no new backend endpoint, since every
caller already has the full search-result payload in hand client-side.

`AddMedia.tsx` (616 → ~330 lines) keeps everything with no equivalent elsewhere — type/provider
picker, title search, ID/URL match, .nfo import, course-URL scrape — but every path now hands its
result to `AddPreview.tsx` instead of expanding an inline form; it has no more knowledge of root
folders, quality profiles, or monitor strategy at all. `GlobalSearch.tsx`'s "Add new" results
already fetched the same rich `/metadata/search` payload but were discarding it and making
`AddMedia.tsx` redo the search from scratch (`/add?type=X&q=title`) — now it navigates straight to
`AddPreview.tsx` with the result already in hand, both fixing the redundant re-search and getting
the same detail-page-styled preview. `FriendLibraries.tsx`'s "Add" link (title/type hint only, no
full result) still goes through `AddMedia.tsx`'s own search first, same as before. The
`MetadataSearchResult` shape all of these share is now one exported interface in `web/src/types.ts`
instead of three near-duplicate local ones.

Verified live against the running dev server: a temporary movie fixture confirmed the new
checkbox-based remove dialog; a real manual-entry add (no external metadata dependency, since this
sandbox's outbound network access can't reach TMDB/Open Library) round-tripped through
`AddPreview.tsx` into a real library item, and adding the same title again correctly triggered the
duplicate-confirm dialog and completed on retry; the toast system confirmed rendering a real
in-app notification (`MediaAnalyzer.tsx`'s "Analysis started" message). Both test items and the
movie fixture were deleted after verification.

## Round 305 — the last 9 components: icon-button rollout is complete
Closes out the icon-button effort that started at Round 294. `Modal.tsx`'s "✕" close button —
used by literally every modal in the app — is now a real `XIcon`, the last raw-glyph-as-button-
child holdout (`DropdownMenu.tsx`'s "▾"/"▸" disclosure suffix is a small state indicator glued onto
caller-controlled text, not a standalone button, so it stays as-is, same call already made for the
identical pattern in `RecycleBin.tsx`/`LibraryType.tsx`). `FolderPicker.tsx`'s "Create" (paired
1:1 with its own "New folder name" input, a genuine mini-toolbar) converts to `PlusCircleIcon`;
its "Select this folder"/Cancel footer stays text — that pairing is this modal's actual primary
confirm/cancel action, the same shape every modal-footer pair in this rollout has kept as text.

The other 7 needed zero changes, each a shape an earlier round already named: `ApiKeyGate.tsx` (9
buttons — Continue/Back TOTP pairs, a lone primary "Create admin account", and the account-mode
selector the original plan explicitly called out as a stays-text tab strip) and
`SearchMatchModal.tsx` (4 — the by-title/by-ID toggle, ditto, plus two lone primary form submits)
needed nothing beyond what Round 294's plan already decided for them by name.
`NamingSetupModal.tsx` (4) is a modal-footer Save/Reset-to-default/Cancel trio (extends the
established 2-button-footer-stays-text rule to 3) plus a row of token-insert buttons whose LABEL
*is* the token being inserted (`{title}`, `{season:00}`) — can't be iconified, the text is the
payload, same reasoning as LibraryType's letter-index strip. `RenamePreviewModal.tsx` (2) is a
count-bearing "Rename N file(s)"/Cancel footer. `SettingsProviderTiles.tsx` (1, "Send test
notification") is the tile-click-to-Modal shape with one lone action at the bottom — stays text
regardless of ZapIcon being established elsewhere, per Round 299's rule that the shape decides,
not icon availability.

**All 49 `web/src/pages/*.tsx` files (Round 294-304) and all 16 `web/src/components/*.tsx` files
(this round) are now fully resolved.** The Servarr-style icon-button rollout that began at Round
294 is complete.

Verified live: reopened the real `Scheduled Backups` → `Browse for a folder` nested-modal flow
(System.tsx → FolderPicker.tsx) against the running dev server — both dialogs' close buttons and
the "Create folder" icon button all render and label correctly, confirmed via the accessibility
tree; closed both without changing any real setting.

## Round 304 — 13 smaller pages converted to icon buttons, 6 needed zero changes
`TrackDetail.tsx` (Back), `CalendarDay.tsx` (Back, Open/Remove), `Blocklist.tsx` (row Remove —
deliberately not `.danger`, since un-blocklisting is reversible and the original used `secondary`
not `danger`), `AuditLog.tsx` (Previous/Next pagination), `Recommendations.tsx` (Add, Not
interested), `Jobs.tsx` (inline schedule Save, Run now, Cancel), `Collections.tsx` (card Delete),
`CollectionDetail.tsx` (Up/Down reorder, Remove), and `RecycleBin.tsx` (Recycle/Dismiss on the
corrupt-media review table, Restore/Delete forever on the recycled-files table) all converted
cleanly using icons already established in earlier rounds.

`FriendLibraries.tsx`, `WatchlistImport.tsx`, and `MediaAnalyzer.tsx` needed one conversion each
once a closer look turned up a fitting established icon: the missing-items table's "Add" (now
PlusCircleIcon, matching Recommendations.tsx), "Choose CSV file..." (now FolderIcon, matching
every other folder-browse trigger in the app), and "Analyze now" (now ZapIcon, the same
trigger-a-background-job icon `Jobs.tsx`'s "Run now" uses) respectively — everything else on those
three pages stayed text: mode choosers, modal-footer Save/Delete pairs, and count-or-loading-label
buttons ("Merge N into the kept item", "Import N title(s)") where the label itself carries
information an icon would drop. `Duplicates.tsx`, `InviteAcceptPage.tsx`, `Onboarding.tsx`,
`Account.tsx`, and `CustomColumns.tsx` needed zero changes, each matching a shape an earlier round
already decided stays text (count-bearing Merge, primary-CTA-only, first-run welcome screen,
Settings.tsx's 2FA section mirror, and AiProviders.tsx's tile-and-modal pattern).

`SubItemDetail.tsx` got the full toolbar treatment (Search, Download for YouTube items, Mark as
missing, Back, Grab in the search-results modal, Fetch tracks) plus two new icon choices: CpuIcon
for "Scan for ISBN" (reading a file's own contents to identify it, the same idea as MediaDetail's
AI Identify) and ShareIcon for "Send to Kindle" (sending the file to an external destination, same
idea as Calendar's calendar-app subscribe). Its toolbar's plain-text "Monitor"/"Unmonitor" button
was also replaced with the actual `MonitorToggle` component already used for the same field two
rows up in this same page's own details table — `EpisodeDetail.tsx`'s toolbar already does this
rather than duplicating the action as a second, differently-styled control. "Convert to
chapterized M4B" stayed text: standalone (not in the toolbar row), no established icon fits, and
its loading label doubles as an important warning ("this can take a while").

Verified live against the running dev server: real data for Duplicates/Jobs, a temporary
friend-library fixture, and temporary media-item/sub-item fixtures (an audiobook chapter and a
standalone book, inserted and removed via direct DB access) for SubItemDetail's fuller
has-file/parent-type conditional toolbar, including one under an "author" parent to reach Scan for
ISBN and Send to Kindle. No regressions; light theme spot-checked on Jobs.tsx.

## Round 303 — AddMedia (no changes) + 8 Configuration-adjacent pages converted to icon buttons
`AddMedia.tsx` (616 lines) needed zero changes — every one of its 8 buttons is either a segmented
mode toggle (Search by title/Match by ID, Add manually/Search metadata instead) or a primary form
submit (Search, Match, Load NFO, Fetch course info, Add to library), and its search results render
as clickable cards, not buttons. `AiProviders.tsx` and `IrcFeeds.tsx` also needed zero changes —
both use a "click a tile, edit in a Modal" pattern structurally identical to `Settings.tsx`'s
tile-panels (just Modal-based instead of inline), so the same "lone panel action stays text"
reasoning applies directly: Test connection, Save/Add, and Delete are all exactly the shape Round
299 established as text.

The other six DID have real toolbar/table shapes to convert: `Indexers.tsx` (Add indexer + Test
all in the top toolbar, row-level Test/Delete — "Sync from Prowlarr"/"Sync from Jackett" stayed
text, same distinguishing-label reasoning as Round 299's "Sync Radarr/Sonarr formats"),
`DownloadClients.tsx` (a standalone "Test all" converted since ZapIcon=Test is now established
from Indexers.tsx moments earlier in this same round; the paired "Test connection"/"Check health"
inside the edit modal stayed text since forcing only one of a two-button row to convert would look
worse than either extreme, and "Check health" has no established icon), `ImportLists.tsx` (Sync
now/Delete row pairing), `IptvPlaylists.tsx` (Attach paired with its picker select, Detach,
Up/Down/Remove in the items table), `RemoteLibrary.tsx` (Browse, paired with its instance/type
selects), and `Users.tsx` (a standalone "Dismiss" now converts too, since XIcon=Dismiss was
established by `ImportReview.tsx` in Round 302; Revoke row actions in both the Invites and Active
Sessions tables).

Verified live against real fixtures (a temporary indexer, inserted and removed) and real data
already in the instance (existing download clients, real active sessions) — confirmed the
Indexers row Test/Delete icons, the paired-text Test-connection/Check-health modal, and both
Revoke icons in Users.tsx's session/invite tables. No regressions.

## Round 302 — ImportReview, Discover, Requests, GlobalSearch, EpisodeDetail converted to icon buttons
Five more pages, continuing the icon-button rollout beyond the original priority list.
`ImportReview.tsx` (Match.../Dismiss row actions) and `Requests.tsx` (Approve/Reject/Cancel row
actions, a new `CheckIcon` use for Approve) were both clean, small tables — straightforward
conversions. `Discover.tsx`'s poster-grid Add/Request buttons (one per card, same shape as
`MediaDetail.tsx`'s TMDB-collection-part Add button from Round 295) both use `PlusCircleIcon` —
they're mutually exclusive per card (admin sees Add, everyone else sees Request) so reusing one
icon for both creates no ambiguity. `GlobalSearch.tsx` needed no changes at all — its only button is
the primary search-submit (stays text) and "Clear" (next to Recent searches) turned out to already
be a styled `<span>` link, not a `<button>`, so it was never in scope.

`EpisodeDetail.tsx` — flagged during Round 296's live-testing as missing from the original survey —
turned out to closely mirror `MediaDetail.tsx`'s own manual-import/search-results panels, so every
icon choice reused directly: the main toolbar (Search/Manual-Import/Mark-as-missing/Back-to-show),
and found the SAME "component already imported but not used for the main toggle" pattern Round 295
fixed in MediaDetail — `MonitorToggle` was already imported and used inline elsewhere on the page,
but the main toolbar had its own separate plain-text Monitor/Unmonitor button doing the identical
toggle; replaced it with the existing component instead of converting it to a new icon button.

Verified live: ImportReview and Requests confirmed against temporary fixture rows (inserted and
removed after), EpisodeDetail confirmed against a temporary test episode showing every toolbar icon
including the file-gated "Mark as missing". Discover couldn't be verified against real data (no
TMDB key configured in this instance) but uses an already-proven pattern. No regressions.

## Round 301 — Missing.tsx, CutoffUnmet.tsx, Calendar.tsx, Dashboard.tsx converted to icon buttons
Four smaller, clean-shaped pages in one round — all genuinely toolbar/table-shaped throughout (no
`SettingsSectionTiles`-style lone-panel buttons to filter out this time). `Missing.tsx` and
`CutoffUnmet.tsx` share the same layout (a bulk-select bar, a per-section "Search all", and
per-row Search/Open) and got identical treatment: SearchIcon for every search action (including
the per-series "Search all missing in this series" in Missing's episode grouping), and the new
`ArrowRightIcon` (added in Round 300) for every "Open" row action. `Calendar.tsx` got chevrons for
month/agenda navigation, `CalendarIcon` for "Today" (jump to the current date on the calendar
you're already looking at), `PlusCircleIcon` for "Add custom date", `ShareIcon` for "Subscribe from
calendar app..." (generating an external feed URL is the same "give this to something else"
concept as `MediaDetail.tsx`'s Share button), and `TrashIcon`/`ArrowRightIcon` for the day-detail
table's Remove/Open row actions — "Regenerate URL" for the ICS token stayed text, matching the
established "consequential, standalone security-token action" exception. `Dashboard.tsx` got a new
`SlidersIcon` for "Customize layout" (established here as this rollout's "adjust settings/layout"
convention) and upgraded its two reorder buttons from raw ↑/↓ text glyphs to real `ArrowUpIcon`/
`ArrowDownIcon` SVG components, matching the same upgrade already done for `LibraryType.tsx`'s
group-delete glyph in Round 297.

Verified live: Missing's bulk-select bar and per-section search icons work against real data,
Calendar's month navigation and day-detail panel render correctly, Dashboard's customize-layout
panel shows correctly disabled up/down arrows at the first/last row. No regressions.

## Round 300 — System.tsx: icon buttons, refined by a "does this icon read on its own" test
`System.tsx` (27 buttons) mixes both shapes seen so far — some tabs (Backups) use
`SettingsSectionTiles`, others (Overview/Health/Maintenance/Insights/Logs) use plain tables and
toolbar rows closer to `LibraryType.tsx`'s shape. Converting it surfaced a sharper version of the
rule Round 299 established: a button converts when it's either (a) part of a genuine multi-button
row/pairing, or (b) a LONE button whose icon is already an established, unambiguous convention
elsewhere in this rollout (Refresh/Download/Delete) — since users have already learned that icon's
meaning. A lone button with a RARE, specific action and no established icon (Check for updates, Run
archival now, Load reputation stats, Run validation) stays text even when nothing else is nearby,
since forcing an icon there would just mean "guess, or hover for the tooltip every time."

Converted: Health's lone "Refresh" (established icon, safe alone), Backups' "Download backup"/
"Restore from backup..." pairing (Download/Inbox icons — Inbox since restoring is literally
uploading a backup file, matching the existing Manual-Import convention) and its "Browse..."
button, two "Open" row-actions in result tables (a new `ArrowRightIcon` added to `ActionIcons.tsx`,
pairing with the existing `ArrowLeftIcon`), Cleanup Suggestions' row-level "Delete", and the Logs
tab's "Load logs"/"Refresh"-toggling button + "Download .log" (a real toolbar row, select+input+
buttons together) plus Log Files' own lone "Refresh" and row-level "Download".

Stayed text: the Maintenance tab's 6-button cluster (Run archival now / Scan library for existing
files / Scan for orphaned files / Full orphaned-file scan / Run Trakt sync now / Run Plex watchlist
sync now) — six mutually-confusable, rare, high-consequence actions bunched together with no clean
1:1 icon mapping, the same "label carries essential distinguishing info" reasoning applied
repeatedly this rollout, just at a larger cluster size than before. "Find unmonitored + no file"/
"Find duplicate files" (both would need the same Search icon, indistinguishable from each other).
"Delete all {N}" (the count in the label is meaningful safety information an icon would discard).

Verified live against the real running server: backup/restore icons render with correct danger
styling, the Logs tab's button correctly toggles its aria-label between "Load logs" and "Refresh
logs" as state changes, real log data loads and displays correctly. No regressions.

## Round 299 — Settings.tsx: icon buttons where they actually fit
Continued the Phase 2 rollout, but `Settings.tsx` (41 buttons in the original survey) turned out to
need a genuinely different treatment than `Activity.tsx`/`MediaDetail.tsx`/`LibraryType.tsx`. Those
three pages are built around dense toolbar/table rows — several actions sitting side by side, where
icons read cleanly as a group. `Settings.tsx` is built around `SettingsSectionTiles`: click a tile,
get a dedicated, mostly-textual form panel for that one root folder/tag/quality/quality-profile/
delay-profile/release-profile/custom-format/subtitle-provider, with usually exactly ONE action
button at the bottom (Delete, Regenerate, Test, Sync, Import, Set up 2FA, ...). Converting a single
lone button to an icon in the middle of an otherwise all-text, all-label form panel doesn't read as
"organized" the way a row of several icons does — it reads as an orphaned glyph with no siblings to
give it context, which is worse than what it replaced. Real Sonarr/Radarr keep exactly this shape
of button (a lone destructive/consequential action at the bottom of a settings panel) as text too.

So this round converted only what's genuinely row/toolbar-shaped: the three list-style tables at
the top of the file (Blocklist/Tags/Import-Exclusions, each a real multi-column table with a
row-level Remove/Delete in the last column — TrashIcon), the root-folder path picker's "Browse..."
button (paired with an input, same shape already converted in `MediaDetail.tsx` — FolderIcon), and
the quality ladder's "Move up"/"Move down" pair (a genuine 2-button mini-toolbar with an
unambiguous icon pair — ArrowUpIcon/ArrowDownIcon). Everything else — every "Delete {X}" at the
bottom of its own settings panel, every Regenerate/Test/Sync/Import/Show-URL/Register-command
button, and "Sync Radarr formats"/"Sync Sonarr formats" (same "label carries essential
distinguishing info" reasoning as `MediaDetail.tsx`'s "Fetch from {provider}") — stays text.

Verified live: the quality reorder icons show correct disabled state at the first/last rank, the
folder-browse icon opens the picker correctly, and no regressions elsewhere in the tab strip or
panel forms.

## Round 298 — audit web/ for the stray-"0" JSX conditional bug
Follow-up to the bug found in Round 296: any `0 | 1`-typed field (not `boolean`) used bare in a
JSX `&&` chain — `{subItem.hasFile && (...)}` — renders the literal number `0` as a visible text
node when the field is 0, since `&&` returns the first falsy operand rather than coercing to
`false`. Enumerated every `0 | 1`-typed field across `web/src/types.ts` and every page/component
file with its own locally-defined interface (`monitored`, `hasFile`, `protected`, `enabled`,
`useFlareSolverr`, `useSsl`, `audioOnly`, `pauseGrabsAtQuota`, `autoApprove`, `isDefault`,
`require_review`, `insertAfterEachItem`), then grepped every `web/src/pages/*.tsx` and
`web/src/components/*.tsx` file for bare usage. Found two more genuine instances in
`SubItemDetail.tsx` (the "Scan for ISBN" and "Send to Kindle" button conditionals, both keyed off
`subItem.hasFile`) and fixed both with `!!subItem.hasFile`. Confirmed every other match already
used a safe form (`!!field`, or `!field` — logical NOT always produces a real boolean regardless of
operand type, so that pattern was never actually at risk). Verified live against a real sub-item
with `hasFile: 0` — no stray "0" renders, and the file-gated buttons correctly stay hidden.

## Round 297 — LibraryType.tsx converted to icon buttons
Continued the Phase 2 rollout — `LibraryType.tsx` (39 buttons in the original survey) is now fully
converted: the group-browse level (Edit/Add description, Add group, and upgrading the existing
raw "✕" glyph delete button to a real `XIcon` for visual consistency with the rest of the icon
set), Save/Delete view, the quick-add button, Scan & Import/Refresh/Organize & Rename, pagination
(Previous/Next → chevrons), and the whole bulk-action bar (Monitor/Unmonitor/Search selected/
Remove/Apply/Apply tag).

Left as text, deliberately, extending the established exceptions: `DropdownMenu`'s own menu items
(View: Posters/Overview/Table, Export CSV/.nfo/JSON/.plexmatch/Calibre, Bulk edit via CSV) stay
text — a vertical menu list needs readable labels the way any app's dropdown does, unlike a row of
standalone icon buttons; converting only the dropdown *trigger* to icon-only while keeping menu
items textual would also lose the trigger's "shows the current selection" affordance (e.g. "View:
Table") that a bare icon can't convey. "Import from Media Server" and "Import from {StarrApp}" stay
text since which external system is being imported from is essential, not decorative, information
— same reasoning as `MediaDetail.tsx`'s "Fetch from {provider}". "Select"/"Done selecting"/"Select
all on page"/"Select none"/"Clear selection" all stay text, matching the precedent already set by
`Activity.tsx`'s own selection-composition controls in Round 294.

Verified live: main toolbar renders correctly, the bulk-action bar's icons and Apply/Apply-tag
flow work, and the group-browse level's "Add System" (ROMs, a grouped type) renders with the
correct dynamic label. No regressions.

## Round 296 — MediaDetail.tsx: the rest of the file converted to icon buttons
Finished what Round 295 started — every remaining row/toolbar action button in `MediaDetail.tsx`
is now icon-only: the season toolbar (Sync scene numbering, List/Tiles view toggle — a new
`GridIcon` added to `ActionIcons.tsx` for "tiles"), each season's own action row (Search season,
Scan & Import, Manual Import, Organize & Rename, Refresh), episode row actions (Search, Manual
Import), collection-shape sub-item row actions (Download, Search, Manual Import), the search-
results modal's Grab/Blocklist buttons, and the manual-import browse panel's navigation (Back to
downloads, Browse this folder, Up, AI Identify, per-row folder Open). Left as text, deliberately:
primary form-submit CTAs (Save metadata, Save location, Split N episodes, Apply merged metadata,
Import N checked files) and the per-provider "Fetch from {provider}"/"Set as backdrop"/"Set as
poster" buttons, where the label itself carries essential information an icon can't — matching the
conventions from Round 294.

`MediaDetail.tsx` (53 buttons in the original survey) is now fully converted. Verified live against
three different item shapes — single (a movie), episodic (a temporary test series with 2 seasons/3
episodes, inserted and removed after), and collection (an existing audiobook with a sub-item) — via
the accessibility tree, confirming every button's `aria-label` and every shape-conditional
(Move to group/Split/Check for corruption/Artwork only showing where they always did) survived the
conversion unchanged. No regressions found this round.

## Round 295 — MediaDetail.tsx: main header toolbar converted to icon buttons
Continued the Phase 2 icon-button rollout — `MediaDetail.tsx` is the largest file in the survey
(53 buttons), so this round scopes to its highest-visibility section: the header (Share, File
details toggle, the 3 small "Add" buttons next to collection/tag/TMDB-collection-part pickers) and
the full main action toolbar (Monitor, Protect, Mark watched, Search now, Manual Import, Scan &
Import, Refresh, Edit metadata, History, Organize & Rename, Check for corruption, Export .nfo,
Search for a different match, Export for Plex, Move to group, Split, Artwork, Remove — 18 buttons
total). The plain-text Monitor/Unmonitor button was replaced with the existing `MonitorToggle`
component (already icon-only, already used elsewhere, just not here) rather than reinventing it.
Toggle-state buttons reflect state the same way `MonitorToggle` already does — an accent-colored
icon when active (Protect, Mark watched) — and panel-open/close buttons (Edit metadata, Move,
Split) swap between their action icon and an X when open, matching their "Cancel X" text before.
Added a new `EyeIcon` to `ActionIcons.tsx` for the watched toggle.

Found and fixed a genuine pre-existing bug while verifying live: two conditionals used
`item.hasFile` (typed `0 | 1`, not `boolean`) bare in a JSX `&&` chain — `{item.hasFile && (...)}`
— which renders the literal number `0` as a stray text node when `hasFile` is 0, since JS's `&&`
returns the first falsy operand rather than coercing to `false`. Confirmed visually (a stray "0"
appeared on the page for a missing/no-file item) before fixing both with `!!item.hasFile`. The same
pattern likely recurs elsewhere in the frontend (any `0 | 1`-typed field used bare in `&&`) —
flagged as a follow-up task rather than chased site-wide in this round.

Verified live against the running `aonarr-server` container in both themes: icon-swap on
open/close, accent-color on toggle-state buttons, and the stray-"0" fix all confirmed working.
Remaining in this file for future rounds: the season/episode table's own row actions, the
search-results table, the manual-import browse panel, the artwork picker, and the metadata-merge
table.

## Round 294 — Servarr-style icon buttons + Activity page overhaul (Phase 1)
First round of a visual pass matching Sonarr/Radarr/Lidarr/Readarr/Whisparr conventions more
closely: icon-only action buttons instead of text-labeled ones, and a fully reworked Activity
page. Added `web/src/components/ActionIcons.tsx` (Trash/X/Check/Pencil/ArrowLeft/ChevronLeft/
ChevronRight/ArrowUp/ArrowDown/Folder — the same 18px stroke-SVG style as the existing
`NavIcons.tsx`, reusing several of its icons too: Search/Download/RotateCcw/PlusCircle/Zap/Slash/
Inbox/etc.) and a new `button.icon-button`/`button.icon-button.danger` CSS class formalizing the
ad hoc inline styles `MonitorToggle.tsx` used before this class existed. Convention going forward:
row/toolbar action buttons (Delete, Edit, Search, Refresh, Sync, Retry, Prioritize...) go
icon-only with a tooltip; primary form-submit CTAs and tab strips stay text, matching what real
Sonarr/Radarr actually do; view-mode switchers go icon-only.

The Activity page (`web/src/pages/Activity.tsx`) got the deeper rework: every Queue action button
is now icon-only, and the Queue table gained Season/Indexer/Protocol/Download Client columns and a
per-status icon alongside the existing text badge — all from data the backend was already
returning (`indexerId`/`downloadClientId`/`episodeId`/`seasonNumber` were already present in
`queueItemFromRow` but untyped/unrendered on the frontend) plus a client-side join against the
already-existing `/indexers` and `/download-clients` endpoints — no backend changes needed. Added
a Protocol filter alongside the existing Status filter, and Sonarr-style bulk selection (mirroring
`LibraryType.tsx`'s established `selectMode`/`selected: Set`/bulk-action-bar pattern): a checkbox
column, select-all-visible/clear-selection, and a bulk action bar for Remove/Remove & Blocklist/
Retry import across every selected item at once. Both the Queue and History sections were migrated
off their own hand-rolled sort state onto the shared `useSortableTable` hook (already used by
`HistoryPage.tsx`), extending the sortable columns to cover everything new. Verified live against
the running `aonarr-server` container (temporary queue fixture rows inserted directly, removed
after) via the dev-server preview: all new columns render correctly (including real download-client
name resolution), bulk-select and the bulk action bar work, sorting works across every column, and
both light and dark theme render the new icon buttons cleanly.

This is Phase 1 of a larger effort — the remaining ~46 page/component files still have
text-labeled buttons and will be converted in priority-ordered batches in future rounds, each
verified the same way before moving to the next.

## Round 293 — encryption.ts: proving key persistence on disk, not just in-process round-trips
Continued down the fresh ratio-scan list. `encryption.ts` (0.72, 93 lines) already had solid
round-trip/mismatch/reload coverage, but every existing test only proved behavior WITHIN one
process — `cachedKey` masks whatever actually landed on disk, so nothing previously confirmed the
generated key FILE itself is valid, which is what actually matters for surviving a restart or a
database restore onto a different config volume (the exact scenario this file's own module comment
is written around). Added a test that deletes the key file, triggers creation via `encryptValue`,
and reads the file back directly to confirm it holds a genuine 64-hex-character key rather than
just something that happens to round-trip in memory. Also added the corrupted-key-file branch — a
key file that EXISTS but fails the hex-format check takes a different code path (falls through
normally, no exception) than a missing file (caught via `try`/`catch`) though both end up
regenerating a fresh key; and `decryptValue`'s behavior on a truncated/malformed encrypted value
(not just a wrong-key one) — a genuinely different real-world failure mode, e.g. settings-table
corruption, still throws rather than producing something undefined. No source bug — every branch
already worked correctly. Full suite: 1362 → 1365 tests, 89 files.

## Round 292 — recommendations.ts: the series pipeline and a documented-but-unproven dedup guard
Continued down the fresh ratio-scan list. `recommendations.ts` (0.67, 309 lines) had reasonable
movie-recommendation coverage, but `recommendSeries` — TMDB's TV-shaped sibling of the well-tested
`recommendMovies`, reading different field names (`name`/`first_air_date` instead of
`title`/`release_date`) — had never been exercised by a single test, and neither had
`recentlyWatchedLibraryItems`'s series branch (joining `episodes` to `media_items` to find the
most-recently-watched episode per show) or `runAutoRequestFromWatchHistory`'s series-episode
insertion path. Added one end-to-end test covering all three at once: a watched series correctly
produces a TMDB TV-shaped recommendation. Also added the DB-level proof for
`runAutoRequestFromWatchHistory`'s `insertedThisRun` guard — its own comment explains it exists
because `getRecommendations()` computes "added" and "watched" (and each individual source item)
independently, so the exact same TMDB id can legitimately appear twice in one batch from two
different source items, but nothing previously proved the guard still prevents a double-insert. Two
source movies engineered to both recommend the same target confirmed exactly one row (and one log
line) resulted, not two. Rounded out with `tmdbSimilar`'s `!res.ok` branch (a failed TMDB request
degrades to no results, not a throw). No source bug — every branch already worked correctly,
including the duplicate-prevention guard its own comment specifically calls out. Full suite: 1358 →
1362 tests, 89 files.

## Round 291 — releaseParser.ts: source-detection branches masked by an untested title, plus dedup/fallback edges
Continued down the fresh ratio-scan list. `releaseParser.ts` (0.62, 261 lines) was already well
tested overall, but re-reading `detectSource`'s if-chain (Remux checked before Bluray before
WEBDL/WEBRip/HDTV/DVD) against the existing fixtures turned up a real blind spot: the only
BluRay-tagged title in the suite also contains "REMUX" in the same string, so Remux (checked first)
always wins there — that existing test could pass whether or not Bluray-alone detection actually
worked, since nothing exercised a BluRay title without a Remux tag alongside it. Added a
Bluray-only title, its "bdrip" spelling, a WEBRip title (previously zero coverage; every existing
WEB-flavored fixture happened to use WEBDL), and a DVD-only title (proving `detectQuality`'s
special-cased bare `"DVD"` return, since a DVD release has no resolution tag to combine with a
source). Also added the documented-but-never-asserted "resolution present, no recognized source at
all → assume WEB-DL" fallback, a language-dedup test proving two different literal tokens
("TrueFrench" and "French") that map to the same canonical tag collapse to one result instead of
two, a null-release-group case, leading-zero stripping in the `1x01`-style fallback notation, and
`releaseMatchesEpisode`'s scene-numbering guard requiring BOTH `sceneSeasonNumber` AND
`sceneEpisodeNumber` together (supplying only one must be ignored, not partially applied). No
source bug — every branch, including the ones masked by a previously-untested title shape, already
worked correctly. Full suite: 1349 → 1358 tests, 89 files.

## Round 290 — quality.ts: the fire-and-forget cache invalidator and two boundary shapes
Continued down the fresh ratio-scan list from Round 289. `quality.ts` (0.57, 139 lines) was already
solidly tested overall, but `invalidateQualityRankCache` — the one exported function with zero
coverage — is the file's fire-and-forget cache-refresh entry point (its own doc comment names it as
one of exactly three call sites in the whole codebase): it fires `loadQualityCaches()` and attaches
`.catch()` without awaiting it. Added a success-path test (a newly inserted quality becomes visible
to `qualityRank` shortly after calling it, without the caller awaiting anything) and a failure-path
test proving the `.catch()` genuinely swallows a rejection rather than leaking an unhandled
rejection — forced a real DB read failure by renaming the `qualities` table out from under it for
the duration of one call (restored immediately after), then listened for `process`'s
`unhandledRejection` event, the same technique validated on `ircFeedManager.ts`'s announce-handler
wiring. Also closed two narrower gaps: `sizeWithinQualityBounds`'s min-only and max-only bound
configurations were previously only ever tested together (both set on the same row), never proving
the two `!= null` guards are actually independent; and `pickBestAllowedQuality` never had a test
proving a candidate sitting exactly *at* the cutoff (not just strictly below it) is included, nor
that its below-cutoff fallback correctly ranks among *multiple* eligible candidates rather than just
returning whichever one happened to be present. No source bug — every branch already worked
correctly, including the cache-invalidation failure path. Full suite: 1343 → 1349 tests, 89 files.

## Round 289 — mediaAnalysis.ts: `runLibraryAnalysis`, the only file-mutating function, had zero coverage
Re-ran the ratio-scan against the current codebase now that the original candidate list (Rounds
283-288) is closed. `mediaAnalysis.ts` (0.54, 334 lines) turned out to be another instance of the
"only the pure/read-only surface is tested" pattern: `analyzeCompatibility` (10 tests) and
`getLibraryAnalysis` (6 tests) were both already well covered, but `runLibraryAnalysis` — the
function that actually re-probes files with ffprobe and writes the result back into
`media_items`/`episodes`/`sub_items` — had never been called by a single test. Added 8 tests
mocking `ffprobe.js`'s `probeMediaInfo` via the established closure-indirection pattern: a
successful probe updates the right row's `media_info`, a non-probeable extension is skipped without
calling the probe at all, a null probe result counts as `failed` without touching the row, episodes
and sub_items are each updated in their own table (not their parent's), a single call's
`probed`/`failed` counts aggregate correctly across all three tables, and — the two branches most
worth proving given this function does real, repeated DB writes — an already-aborted `AbortSignal`
returns immediately without probing anything, and a signal that aborts mid-scan stops before the
next row rather than finishing the batch. Every test used its own never-reused synthetic `type`
value (this file's tests otherwise share one un-cleaned DB) so none of the eight could pick up
another test's leftover rows. No source bug — every branch, including cancellation, already worked
correctly. Full suite: 1335 → 1343 tests, 89 files, stable across the run (no recurrence of Round
288's full-suite-only flakiness).

## Round 288 — mediaQuery.ts: 3 of 8 status filters, and their underlying heuristics, untested
Last candidate from the original ratio-scan list (0.47, 213 lines). `buildMediaQuery`'s existing 15
tests covered most of its filter surface, but three of its eight `status` values —
`cutoffUnmet`, `filenameMismatch`, and `unmatched` — were never exercised, including the two real
algorithmic heuristics behind the first two (`findCutoffUnmetIds`'s quality-vs-profile-cutoff
comparison, `filenameLooksMismatched`'s significant-word-overlap check) — the same kind of "the
public function's own real logic was untested" gap found repeatedly this phase, just scoped to a
few branches of an otherwise well-tested function rather than the whole file. No source changes;
every branch worked correctly once exercised.

- `tests/mediaQuery.test.ts` — 15 → 23 tests. `status:unmatched` (null/empty/`{}` `external_ids`);
  a specific (non-`"all"`) `contentRating` filter; `status:cutoffUnmet` (an item below its quality
  profile's cutoff included, one at or above it excluded, and the `where:null` short-circuit when
  nothing qualifies); `status:filenameMismatch` (a file whose name shares too few significant words
  with its title flagged, a well-matched one not, and its own `where:null` short-circuit); the
  free-text search actually wiring `toFts5Query`'s output into the SQLite FTS5 subquery (the
  transform itself was already unit-tested, but not that `buildMediaQuery` actually uses it
  correctly) and a blank search term adding no condition at all; `tagId` combined with an explicit
  `type` (both conditions present, tags still joined); and a plain (non-`"none"`) `groupId`.

  A genuinely puzzling test-only issue surfaced on the first full-suite Docker run (isolated to
  this file, and not reproducible when running it alone): the `cutoffUnmet`/`filenameMismatch`
  short-circuit tests found non-empty results, and a fixture's `INSERT` into `quality_profiles` hit
  a `UNIQUE` constraint on a name only that one `it` block ever inserts — both symptoms consistent
  with those specific tests somehow executing more than once against the same database under a
  full-suite run, despite `vitest.config.ts`'s `fileParallelism: false`. The exact mechanism wasn't
  fully pinned down, but the fix is correct regardless of cause: `findCutoffUnmetIds`/
  `findFilenameMismatchIds` scan every `media_items` row with no type filter at all (`allowedTypes`
  only affects a separate, later-joined condition), so their own tests can't assume a clean
  precondition just from being declared "first" — each now does its own explicit cleanup of the
  exact criterion it depends on before asserting anything, making both self-contained and
  idempotent against re-execution regardless of order or repetition. Verified stable across two
  consecutive full-suite runs after the fix.

Test count: 1327 → 1335 (89 files, no new files this round).

## Round 287 — starrImport.ts: 3 of 6 exported functions had zero coverage
Last candidate from the Round 284 ratio scan. `starrImport.ts` (468 lines) migrates an existing
Radarr/Sonarr/Lidarr/Readarr library into AoNarr — 6 exported functions, one pair per *Starr app.
Only `fetchRadarrMovies` (partially) and `importArtistsFromLidarr` (thoroughly, from an earlier
round) had tests; `importMoviesFromRadarr`, `fetchSonarrSeries`, `importSeriesFromSonarr`, and
`importAuthorsFromReadarr` — more than half the file's public surface — had never been exercised
at all. No source changes; every branch worked correctly once exercised.

- `tests/starrImport.test.ts` — 7 → 17 tests. `fetchSonarrSeries` gets direct coverage of its own
  real logic (previously completely untested): mapping a series plus its per-series episodes/files
  (Sonarr's v3 API has no bulk endpoint, so this is an N+1-per-series fetch — proven with two
  independent series in one call), resolving a real file path only for an episode Sonarr reports as
  downloaded, and skipping a title-less series entirely. `importMoviesFromRadarr`/
  `importSeriesFromSonarr` each get one delegation-proof test — the shared match-or-create logic
  they call into (`importMovieItems`/`importSeriesData`) is already thoroughly proven by
  mediaServerImport.test.ts, so these just confirm the fetch-then-delegate wiring itself works.
  `importAuthorsFromReadarr` — the single most under-tested app in the file — gets parity with
  Lidarr's own treatment: a new author+book creation test (confirming the `goodreads` external-
  provider wiring specifically, Readarr's own detail) and an existing-author-matched-by-external-id
  test; `importCollectionData`'s deeper branches (skip-by-known-path-tail, COALESCE metadata fill,
  never-downgrading a downloaded child) are shared code already exhaustively proven via Lidarr, so
  they aren't re-proven a second time for Readarr specifically. Also added one more edge case to
  the existing `importArtistsFromLidarr` coverage: when Lidarr reports more than one track file for
  an album, only the *first* one's directory is used as the album's folder path.

Test count: 1320 → 1327 (89 files, no new files this round).

## Round 286 — duplicateCheck.ts: mergeMediaItems's less-common branches, and the scheduled job
Next candidate from the Round 284 ratio scan. Unlike the last three rounds, `duplicateCheck.ts`'s
existing 8 tests already covered real orchestrator logic (not just pure helpers) — `findDuplicateGroups`,
`mergeMediaItems`'s single/episodic-shape happy paths, `dismissDuplicateGroup`. The gap here was
narrower but still real: several of `mergeMediaItems`'s less-common branches, and
`runScheduledDuplicateCheck` (the scheduled counterpart to the on-demand Duplicates-page sweep),
had zero coverage. No source changes; every branch worked correctly once exercised.

- `tests/duplicateCheck.test.ts` — 8 → 23 tests. `mergeMediaItems` gaps closed: the "collection"
  shape (sub_items, e.g. Music/Books) had never been exercised at all, unlike its single/episodic
  siblings; `deleteFiles: true`'s actual `recycleFile` dispatch was never proven for any shape
  (single-item both-have-files, episodic collision, or collection collision) — every existing test
  only ever passed `false`; tag and collection-membership reassignment (dedup via `INSERT OR
  IGNORE`) was untested; the `REASSIGN_TABLES` loop was only ever proven for `history`, never for
  `blocklist`/`queue`; and the guard branches (empty/keeper-only `loserIds`, a missing keeper
  throwing, a missing or wrong-type loser silently skipped) plus a genuine multi-loser merge in one
  call. `runScheduledDuplicateCheck` gets its first coverage at all: no groups found; a newly-found
  group recorded and notified with its year-formatted title; a group already recorded from an
  earlier run correctly *not* re-notified (needed its own scoped `beforeEach` table wipe — this
  function scans literally every `media_items` row with no filter, and every other describe block
  in this file deliberately accumulates state across tests, so without the wipe a duplicate pair
  from the very first test in the file was still sitting there polluting a "zero groups" assertion —
  the identical `runAllImportLists` shared-table issue from Round 270, recurring in a new file);
  the notified title list capped at 5 while the true count is still reported accurately; and a
  notification failure swallowed rather than thrown. Also added direct tests for
  `findPossibleDuplicates` (previously only exercised indirectly via importLists.test.ts),
  including its deliberately looser year-matching than its `mediaServerImport.ts` cousin
  `titleAndYearMatch`: either side missing a year still allows a title-only match here, where the
  cousin function requires an exact title when either year is unknown.

Test count: 1304 → 1320 (89 files, no new files this round).

## Round 285 — archival.ts: the file-moving/deleting logic itself was completely untested
A third instance of the Round 283/284 pattern, and the most consequential one: `archival.ts`'s
existing 8 tests only covered its small pure/DB-read helpers (`pathTail`, `findWatchedMatch`,
`effectiveRetentionDays`) — `getUpcomingArchivals` (the "Leaving Soon" preview) and, more
importantly, `runAutoArchival` itself — the function that actually **moves or permanently deletes
real media files** off disk once they're watched and past their retention window — had never been
exercised at all. No source changes; every branch, including the cross-filesystem `EXDEV` fallback
and the destructive delete path, worked correctly once actually tested against real files.

- `tests/archival.test.ts` — 8 → 26 tests (pre-existing pure-helper tests untouched). Real
  temp-directory files are used throughout (not mocked fs) so the actual move/delete/copy behavior
  is genuinely verified end to end; only `mediaServer.js`'s `fetchWatchedFiles` (kept real:
  `getMediaServerConfig`, already covered by mediaServer.test.ts) and `recycleBin.js`'s
  `recycleFile` (has its own dedicated test file) are mocked. `getUpcomingArchivals`: no-op without
  a configured media server or on a fetch failure; a watched item's `scheduledFor` computed
  correctly from its real last-played time plus the effective retention window; a never-archive
  override excludes an item; episode/sub-item candidates get their own composed labels; sort order.
  `runAutoArchival`: every no-op gate (not enabled, no media server, no archive folder *and* no
  permanent-delete opt-in); a watched+aged file actually gets moved to the real archive folder on
  disk, the DB row's `has_file`/`path`/`quality` are cleared, and a `history` row is logged; a
  watched-but-not-yet-aged file is left alone; a never-archive override is respected; permanent
  delete routes to `recycleFile` instead of a real move; **one item's archive failure (a real
  `ENOENT` from a file that no longer exists on disk) is caught and logged without aborting the
  rest of the run** — proven with a second, healthy item in the same batch that still gets
  archived correctly; the same shape for episodes and sub-items; the roll-up `UPDATE` that flips a
  show's own `has_file` back to 0 only once *every* one of its episodes has been archived, not
  before; and the `EXDEV` (cross-filesystem) fallback to copy+delete, forced via `vi.spyOn(fsp,
  "rename").mockRejectedValueOnce(...)` since a same-filesystem temp dir can't produce a genuine
  cross-device error naturally.

Test count: 1288 → 1304 (89 files, no new files this round).

## Round 284 — mediaServerImport.ts: the real import logic had the same gap as notifications.ts
A systematic check for more files with this shape (source-to-test line ratio) surfaced
`mediaServerImport.ts` as the next real match: 332 source lines, but its existing tests only ever
exercised the small pure matching helpers (`titlesMatch`, `exactTitlesMatch`, `titleAndYearMatch`,
`externalIdsOverlap`) — the actual `importMovieItems`/`importSeriesData` orchestrators, which do
every bit of the real database matching/creation/update work for importing an existing Plex/
Jellyfin/Emby library into AoNarr, had zero coverage. No source changes; every branch worked
correctly once exercised.

- `tests/mediaServerImport.test.ts` — 12 → 35 tests (the pre-existing pure-helper tests are
  untouched). `importMovieItems`: creates a new row with every field populated correctly
  (`has_file` driven by path presence); skips a title-less item and one whose path-tail is already
  known; matches an existing row by external-id overlap or by title+year, filling in only
  currently-null fields via `COALESCE` — proving a match's title is never renamed and its metadata
  is never overwritten; a match reached via a path-less (Starr-sourced) item never downgrades an
  already-downloaded row's `has_file`/`path`; matching runs against *every* movie, not just
  not-yet-downloaded ones (a documented past-fix, now regression-proof); two media-server items for
  the same new movie in one batch — the second matches the first instead of creating a duplicate
  (also a documented past-fix); a genuine mid-loop `AbortSignal` stop; and a malformed
  `external_ids` JSON on an existing row doesn't crash the match loop. `importSeriesData` gets the
  equivalent coverage one level deeper — the same match/create/`COALESCE`-update shape for shows,
  plus per-episode matching by season+episode under the resolved show, the show-id memoization that
  keeps a multi-episode show from being resolved (or created) more than once, and the roll-up
  `UPDATE` that flips a show's own `has_file` once any of its episodes has one. The two thin
  `import*FromMediaServer` wrapper functions get one delegation-proof test each, with
  `mediaServer.js`'s fetch functions mocked (inert for every other test in the file, since the core
  functions take already-fetched items directly).

Test count: 1267 → 1288 (89 files, no new files this round).

## Round 283 — notifications.ts: the whole notification pipeline had essentially no coverage
While looking for the next file to deepen, `tests/notifications.test.ts` turned out to be only 3
tests covering one small helper (`isEventEnabledFor`) — a narrow Round-229 regression test for one
specific bug fix, not a real test suite. Checking the CHANGELOG confirmed this: `notifications.js`
has been *mocked* as a dependency in dozens of other files' tests across the whole 282-round
history (scheduler.test.ts and others), but never given its own comprehensive coverage — a genuine
gap the file-level "every file has a test file" milestone didn't actually catch, since the file
technically already had one. `notifications.ts` (446 lines) is the entire outbound notification
pipeline: 10 provider sinks (Discord, Slack, a generic webhook, Telegram, Pushover, Matrix, Twilio
SMS, SMTP email, web push, and an admin-configured custom script), 8 event-trigger functions, a
per-provider "Test" dispatcher, and {token}-based template rendering — none of which had ever been
exercised directly. No source changes; every branch behaved correctly once actually exercised, but
in a genuinely close call, see below.

- `tests/notifications.test.ts` — 3 → 40 tests. `push.js`/`smtp.js`/`mediaServer.js` are mocked
  (each already has its own dedicated test file covering its real internals); `node:child_process`'s
  `execFile` is mocked at the raw callback level so `runCustomScript`'s `promisify(execFile)`
  wrapper (built once at module-load time) picks it up correctly. Covers: every sink's request
  shape (URL, headers, body) when configured, and that it's skipped entirely when it isn't; that
  each sink's own `<providerKey>Events` gate is actually wired into `fanOut` (not just that the
  `isEventEnabledFor` helper works in isolation); that one sink failing doesn't stop the others
  (`Promise.allSettled`) and never rejects the calling `notify*` function; `renderTemplate`'s
  settings-override and unknown-`{token}`-passthrough behavior; all 8 `notify*` functions' title/
  color/payload/template, including `notifyImported`/`notifyUpgraded`'s opt-in media-server-refresh
  side effect (and that a refresh failure is caught, not surfaced); `sendTestNotification`'s all 10
  provider branches (throws a specific message when unconfigured, sends when configured, and
  genuinely ignores the event-filter setting — proven by explicitly silencing a provider's events
  and confirming a test-send still goes through); and `runCustomScript`'s env-var construction
  (`AONARR_`-prefixed, camelCase→SNAKE_CASE) plus its two different failure-propagation shapes
  (`fanOut` swallows and logs; `sendTestNotification` lets it throw straight through).

  Two self-inflicted test bugs caught on the first Docker run, both worth remembering: (1) the
  `beforeEach` settings-reset initially used `setSetting(key, "")` for every `<providerKey>Events`
  key too — but `isEventEnabledFor` treats a *truly-unset* setting as "every event enabled" and an
  *explicitly-saved empty string* as "every event disabled" (that distinction is the entire point of
  the Round-227 bug this file's original 3 tests already guard), so the reset was silently
  disabling every provider before each test even started, exactly the `defaultProviderFor`/`??`
  class of mistake from Round 276, recurring in a new file — fixed with `deleteSetting` for those
  keys specifically, `setSetting(key, "")` for everything else. (2) A Matrix test asserted on
  `fetchMock`'s recorded call arguments, which are captured regardless of whether the mocked
  response ever actually matched — the route's own matcher used `%21room%3Aexample` for the room id
  `!room:example`, but `encodeURIComponent` leaves `!` unescaped (it's in the unreserved set), so
  the real URL never matched and the "successful" response was never actually returned; the
  assertions on call *arguments* still happened to pass since those are recorded independent of the
  mock's outcome, silently masking that the "success" path wasn't actually proven end-to-end.

Test count: 1230 → 1267 (89 files, no new files this round).

## Round 282 — deepen test coverage: mediaServer.ts's resilience-branch divergences
Continues the deepening phase, moving to `mediaServer.ts` (its own original round found "the real
Plex-skips-vs-Jellyfin-throws asymmetry on section-fetch failure" — a strong signal this file has
more than one such divergence worth surfacing). No source changes this round — every branch found
was real and already behaved sensibly, just unexercised and, in one case, un-*documented*; no
Docker image rebuild needed.

- `tests/mediaServer.test.ts` — 33 → 38 tests. The clearest find: `fetchMediaServerSeries` (both
  Plex and Jellyfin) silently continues with a partial result when its shows or episodes
  sub-request fails, unlike `fetchMediaServerMovies`'s Jellyfin path, which explicitly throws on
  the same kind of failure — a real, previously-untested (and previously undocumented in a comment)
  divergence between the two "fetch full library details" functions, now pinned down by a test for
  each provider rather than left to be rediscovered by surprise later. Also added: `fetchPlexItems`
  (used by `pushWatchState` to resolve which Plex item to scrobble) skipping a section whose own
  items request fails rather than aborting the whole match attempt; and `refreshMediaServerLibrary`/
  `triggerFullMediaServerScan`'s per-section `.catch(() => {})` on each individual Plex refresh
  call — previously only proven for a rejection at the *sections* list fetch (caught by the
  function's outer try/catch before ever reaching the per-section loop), never for one specific
  section's own refresh call rejecting while its siblings still succeed.

Test count: 1226 → 1230 (89 files, no new files this round).

## Round 281 — deepen test coverage: importLists.ts's four sync-provider parity gaps
Continues the deepening phase, moving to `importLists.ts` (Round 270, Trakt/IMDb/Last.fm/TMDB
list-sync). Applied the same "sibling functions should share the same tested behavior" lens that
found real gaps in Rounds 279-280: the four `sync*List` functions all share the identical
try/catch-per-entry resilience shape, an in-library dedup check, an exclusions check, and (where
applicable) genre filtering — but each function's *own* test coverage of these shared behaviors had
grown unevenly across the 11 prior rounds this file has passed through. No source changes this
round — every gap was a real branch that already behaved correctly; no Docker image rebuild needed.

- `tests/importLists.test.ts` — 35 → 42 tests. Genre filtering had only ever been proven
  end-to-end for TMDB lists (and only via `TMDB_MOVIE_GENRES`, never `TMDB_TV_GENRES` — a TV-only
  genre id like "Kids" has no entry at all in the movie map, so excluding it only proves something
  if the *TV* map is what's actually being read); added the equivalent end-to-end proof for Trakt's
  `entry.genres` and IMDb's CSV `Genres` column, plus a TMDB test that specifically excludes a
  TV-only genre. The in-library dedup check (`existingTmdbIds`, by TMDB id) was proven for Trakt but
  never for TMDB despite sharing the identical mechanism, and its own malformed-JSON tolerance (a
  pre-existing row with corrupt `external_ids`) was untested for either. Last.fm shares IMDb's
  `findPossibleDuplicates` dedup and the standard `isExclude`-based exclusions check, but had never
  had either path exercised — only its happy-path adds. Also added a negative-assertion test proving
  `insertArtistAlbums` never calls `fetchAlbumTracksFor` for an album the provider returned with no
  `externalId` (the field that gates whether a track fetch is even attempted).

Test count: 1219 → 1226 (89 files, no new files this round).

## Round 280 — deepen test coverage: downloadClient.ts's three debrid adapters
Continues the deepening phase, moving to `downloadClient.ts` (Round 274, already yielded one real
shipped bug — the NULL-byte one — so a second, more careful look felt warranted). Focused on the
three structurally-similar "debrid" adapters (Real-Debrid, TorBox, AllDebrid), reading all three
side by side the same way the Last.fm bug was found in Round 277: AllDebrid's own source comments
document two *previous* real bugs in its polling loop (a v4.1 API field removal, and `data.magnets`
sometimes coming back as a bare object instead of an array) — a strong signal this general area of
the file (JSON-shape assumptions in these three providers' polling/upload code) was worth a closer
pass. No source changes this round — every gap found was a real branch that behaved correctly, just
completely unexercised; no Docker image rebuild needed.

- `tests/downloadClient.test.ts` — 54 → 64 tests. The clearest gap, present in *both* Real-Debrid
  and TorBox: every existing test only ever fed the adapter a literal `magnet:` URI or a URL that
  redirects to one — the raw-.torrent-bytes upload branch (`PUT /torrents/addTorrent` for RD, a
  multipart `file` field for TorBox) had **zero** coverage in either adapter, despite being a real,
  regularly-hit code path (an indexer's proxy "get" endpoint that serves torrent bytes directly
  rather than redirecting). Also added: Real-Debrid's documented-but-unverified `selectFiles`
  202-already-selected special case (and its real-error sibling), its 6-hour polling deadline
  actually firing (proven cheaply via `vi.setSystemTime`+`vi.advanceTimersByTimeAsync` rather than
  waiting out thousands of real 5-second poll intervals), and its in-progress percentage reporting
  (previously proven for TorBox's polling loop but never for Real-Debrid's near-identical one);
  TorBox's `body.data` coming back as an array rather than a bare object during polling (mirroring
  the exact defensive-but-unverified pattern already fixed once for AllDebrid); TorBox's
  `download_state` failure match, empty-files case, and a `createtorrent` response with no
  torrent id anywhere; and AllDebrid's generic `call()` helper's `status:"error"` branch (used by
  4 different endpoints in the adapter, and — despite AllDebrid's polling-loop-specific
  `statusCode`-based failures being well tested — never itself exercised), its rejected-magnet
  error-message extraction (both the specific and generic-fallback cases), and `link/unlock`
  returning no direct link.

Test count: 1209 → 1219 (89 files, no new files this round).

## Round 279 — deepen test coverage: indexerClient.ts network retry, FlareSolverr, scene variants
`metadata.ts` (Rounds 276-278) has reached diminishing returns for further deepening, so this round
moves to a different file with the same "several provider/protocol adapters of varying depth"
shape: `indexerClient.ts` (Round 269, Torznab/Newznab/RSS/DDL). No source changes — purely
additional test coverage; no Docker image rebuild needed.

- `tests/indexerClient.test.ts` — 34 → 44 tests. The biggest gap: `withNetworkRetry`/
  `isTransientNetworkError`'s actual retry-then-succeed behavior had **never** been proven — every
  existing rejection test used `mockRejectedValue` (rejects every call identically), which can't
  distinguish "retried and recovered" from "never retried at all." New tests use
  `mockRejectedValueOnce` + `mockResolvedValueOnce` to prove a transient failure (message-matched
  `"fetch failed"`, an `err.code` like `ECONNRESET`, and the nested `err.cause.code` shape some
  runtimes wrap errors in) gets exactly one real retry and recovers — both through
  `checkIndexerHealth` directly and through a full `searchIndexer` torznab search, confirming the
  retried request's data actually flows through to a parsed result. Also proved a non-transient
  error is never retried, and that a *repeatedly*-failing transient error still only gets the one
  retry (not a loop) before giving up. Two other completely untested areas: the FlareSolverr
  proxying path (`fetchIndexerText`'s alternate branch for indexers behind Cloudflare) — POSTs to
  `{url}/v1` with the right request body, strips a trailing slash from the configured URL, only
  applies to an indexer that opted in via `useFlareSolverr` even when the instance-wide URL is
  configured, and surfaces both FlareSolverr's own "could not resolve" message and a non-OK HTTP
  response from FlareSolverr itself; and the query-limit's rolling 1-hour window, which was only
  ever proven to *block* once hit, never proven to actually *reset* once the blocking request ages
  past an hour (via `vi.useFakeTimers()`/`vi.setSystemTime()`). Rounded out
  `generateSceneVariants`'s coverage from 1 of its 4 transform branches to all 4 (and→&,
  drop-leading-article, space→dot, on top of the already-tested &→and), plus the "every variant
  also comes back empty" and "the query has no applicable variant at all" cases.

Test count: 1199 → 1209 (89 files, no new files this round).

## Round 278 — deepen test coverage: metadata.ts token expiry, episode aggregation, tie-breaks
Continues Round 277's "deepen already-tested files" phase, working through the specific gap list
sketched at the end of that round: IGDB token expiry, TVDB/Trakt/AniList episode edge cases, and
MusicBrainz's `pickBestRelease` tie-break logic. No source changes this round — purely additional
test coverage; no Docker image rebuild needed.

- `tests/metadata.test.ts` — 124 → 129 tests. New coverage: IGDB's cached-token *expiry* actually
  triggering a re-authentication (Round 276/277 only ever proved caching, never that an expired
  token gets refreshed) using `vi.useFakeTimers()`/`vi.setSystemTime()` to jump past a short-lived
  token's expiry without needing to fake any real timers; TVDB search/episode results defaulting
  every optional field to null when absent; Trakt's episode fetch aggregating across multiple real
  seasons (previously only ever exercised with one) and defaulting title/overview to null;
  AniList's episode-count lookup returning `[]` for a null or zero count rather than throwing or
  generating a placeholder list; and `pickBestRelease`'s full three-tier sort — Official status,
  then preferred-country, then earliest date — proven as a genuine *tier* ordering (a later date in
  a preferred country beats an earlier date in a non-preferred one; a missing date always loses to
  a real one) rather than just the single-tier case Round 276 covered, using releases where only
  the intended winner's own `/release/{id}` endpoint is stubbed at all — the wrong pick would fail
  on "unmocked fetch call," not silently return wrong data.

  One test-authoring bug self-caught on the first Docker run, itself an instance of a pattern this
  project's memory already flags: the new IGDB-expiry test initially ran *after* the existing
  "authenticates once and reuses the cached token" test in the same `describe` block, so the
  already-warm, still-real-time-valid `igdbToken` module cache from that earlier test meant the new
  test's own auth stub was never even reached (`authCalls` stayed 0). Reordering to run first
  wasn't enough on its own — the fix under fake timers also had to leave its *own* leftover cached
  token in an unambiguously-expired state (a `expires_in: 0` second response) so it couldn't go on
  to poison whichever IGDB test runs after it, regardless of how little real wall-clock time
  elapses between tests.

Test count: 1194 → 1199 (89 files, no new files this round).

## Round 277 — deepen test coverage: metadata.ts edge cases
With the untested-file backlog cleared (Round 276), this round shifts to deepening coverage in
already-tested files rather than starting new ones. `metadata.ts` was the freshest and most
clearly under-tested-by-design target: Round 276 deliberately gave ~25 "secondary" providers only
one happy-path test each. This round went back through that list and added the missing-field
fallback branches (a provider's own JSON commonly omits a field entirely, not just sets it to a
falsy value) each of those functions actually has.

- `tests/metadata.test.ts` — 119 → 124 tests (several existing tests also gained extra assertions
  without adding a new `it`). New coverage: Trakt search omitting the `imdb` key entirely (not
  just `undefined`) when Trakt has none; TVMaze with no image/summary/premiered date; Open
  Library/ComicVine/RAWG/ThePornDB search with every optional field absent; Deezer's
  `cover_medium` → `cover` poster fallback; Goodreads skipping a row with an empty title or no
  author link, and leaving `releaseDate` null when there's no "published YYYY" text; Audible's
  missing `product_images`/`release_date`; RAWG's and IGDB's maker resolution falling back to
  publisher when there's no developer entry; ScreenScraper's region/language helper falling back
  to the first entry when the preferred one is absent; TheGamesDB's `base_url` fallback chains
  (search: medium → original; artwork: large → original → medium); `fetchPlaylistByIdYoutube`
  throwing for a playlist that doesn't exist; confirming `searchMangaAnilist` never sets
  `runtimeMinutes` (unlike the anime/series AniList search, which does); Fanart.tv's `movielogo`
  fallback when `hdmovielogo` is absent; the podcast RSS parser's 500-episode safety cap (proven
  end-to-end with a 501-item generated feed, not just asserted from reading the source); and
  iTunes podcast search falling back to `trackName`/null when `collectionName`/`artistName`/
  artwork are absent.

  One more genuine source bug surfaced — this time caught by inspection before even writing the
  test, while comparing `fetchArtistAlbumsLastfm` against `searchArtistsLastfm` right above it in
  the file: `searchArtistsLastfm` unwraps Last.fm's `artistmatches.artist` field with
  `Array.isArray(matches) ? matches : [matches]`, because Last.fm's API (translated from XML) is
  well known to collapse a single-item list field down to a bare object instead of a 1-element
  array. `fetchArtistAlbumsLastfm`, immediately below it, read `topalbums.album` the exact same
  way but had no such guard — meaning any artist with exactly one top album would crash the whole
  album fetch with `albums.map is not a function`. Fixed with the identical one-line guard already
  used a few lines above it, and reproduced first with a failing test before the fix (rather than
  fixing blind) to confirm the bug was real. Docker `server`/`combined` images rebuilt and pushed
  (`web` untouched, no frontend changes).

Test count: 1189 → 1194 (89 files, no new files this round).

## Round 276 — test coverage complete: metadata.ts, the last untested file
Every service file in the codebase now has a test file. `metadata.ts` (2551 lines, the single
largest file in the codebase by a wide margin) is a huge but structurally flat collection of
~50 private per-provider fetch functions (TMDB, OMDb, Trakt, TVDB, TVMaze, AniList, MusicBrainz,
Deezer, Discogs, Last.fm, Open Library, Google Books, iTunes, Hardcover, Goodreads, AudNexus,
Audible, Comic Vine, RAWG, IGDB, ScreenScraper, TheGamesDB, YouTube, Vimeo, ThePornDB, MangaDex,
Fanart.tv) reachable only through ~20 exported dispatcher functions — none of it touches the
database at all, just `fetch()` and the settings cache. A deliberate, disclosed scoping decision
given the sheer breadth: **full branch coverage on every exported dispatcher** (every provider-id
routing branch, every error path) **and on every function with genuine logic** (year-based
re-ranking and the MusicBrainz→Deezer poster backfill in `searchMetadata`, `pickBestRelease`'s
official/country/date sort and the multi-disc continuous track numbering in
`fetchAlbumTracksFor`, TVDB/IGDB token caching including a forced 401 re-login, YouTube/Vimeo
pagination and their 500-item safety caps, Goodreads' HTML scraping, AudNexus's exact-match sort
with partial-failure resilience, the TMDB collection/person-credits dedup+sort); **one solid
happy-path test per "fetch JSON, map fields" provider function** otherwise, since most of the ~50
share that same trivial shape and differ only in field names.

- `tests/metadata.test.ts` — 119 tests covering `parseProviderUrl`, `searchMetadata` (every media
  type's provider routing including both real `TYPE_SPECIFIC_SEARCH_FNS` overrides — AniList
  manga vs. anime, iTunes podcast vs. author search — plus dispatch-error paths, year re-ranking,
  and the Deezer poster backfill), `fetchByExternalId` (all 9 provider branches), `fetchSeriesEpisodesFor`/
  `fetchSeriesSeasonsFor`/`fetchArtistAlbumsFor`/`fetchAlbumTracksFor`/`fetchCollectionChildrenFor`/
  `fetchArtworkFor`/`fetchRomDetailsFor` (every routing branch + priority order + the empty-id
  fallback), `fetchCastFor`/`fetchAlternateTitlesFor`/`fetchTmdbCollectionFor`/`fetchPersonDetails`/
  `fetchTrailerFor`/`fetchOmdbRatings`/`fetchTrendingMovies`/`fetchTrendingSeries`/
  `fetchMovieByTmdbId`/`fetchSeriesByTmdbId`. Only `settingsStore.js` (via a real `setupTestDb()` —
  this file has no other DB dependency) and `global.fetch` are involved; `cheerio` and `xml2js` run
  for real against fixture HTML/RSS, matching this project's existing scraping-test convention.

  One genuine source bug surfaced: `parseProviderUrl`'s ISBN regex was `/(\d{9}[\dXx]|\d{13})/` —
  since JS regex alternation takes the first branch that matches at a position rather than the
  longest one, a real 13-digit ISBN-13 pasted into a URL always matched the shorter `\d{9}[\dXx]`
  branch first and got silently truncated to its first 10 digits (an invalid id, sent straight to
  Open Library's API). Fixed by trying `\d{13}` first. Two other apparent failures on the first
  Docker run turned out to be my own fixture mistakes, not source bugs: Goodreads' `authorId` is
  the *entire* `/author/show/<id>` path segment including the slugified name (matching real
  Goodreads URLs like `/author/show/153394.Chuck_Palahniuk`), not just its leading digits; and
  MangaDex's cover URL convention appends `.256.jpg` after a cover filename that already ends in
  `.jpg` (a genuine, intentional double extension in their CDN's own URL scheme).

Test count: 1070 → 1189 (88 → 89 files).

## Round 275 — more test coverage (scheduler & auto-search/grab pipeline)
No behavior changes (the exports below add no new logic — see "How to apply" in this project's own
test-writing conventions). The central orchestrator tying together nearly every other service in the
codebase (1474 lines) — the auto-search/grab pipeline is the app's core value proposition, and until
this round none of it had any test coverage at all.

- Exported twelve previously-private functions purely for direct testability (an established,
  low-risk pattern already used elsewhere in this codebase — no logic changed): `isWithinTimeWindow`,
  `isReleaseAvailableForSearch`, `runAutoSearch`, `runAutoUpgrade`, `checkVideoChannels`,
  `checkPodcastFeeds`, `retryFailedGrab`, `pollQueue`, `cleanupStalledDownloads`,
  `pruneOldFailedQueueItems`, `checkHealthAndNotify`, `runSeedGoalCleanup`.
- `tests/scheduler.test.ts` — `isAlreadyQueued`, `pickClientForProtocol`, and `grab` directly; then
  `searchAndGrabTargets` (exercising `chooseBestResult`'s real ranking algorithm indirectly: the
  blocklist gate, the quality-upgrade gate, missing-client/no-results errors, a seeders tie-break
  between two otherwise-identical releases, and one target's exception not aborting the batch);
  `runAutoSearch` across all three shapes (movie/series/collection) plus every one of its skip gates
  — quiet hours, the search window, no enabled clients, a root folder over its configured disk quota,
  already-has-a-file-or-queued, minimum availability — the YouTube/podcast direct-grab special cases
  that bypass indexer search entirely, a future-dated daily-series episode never being searched, and
  a genuine mid-loop `AbortSignal` stop; `runAutoUpgrade`'s enabled-gate and already-queued skip;
  `checkVideoChannels`/`checkPodcastFeeds`'s new-item detection and conditional auto-grab;
  `pollQueue`'s full state machine (progress/remote-path-mapping updates, completed → import,
  `ImportSkippedError` → manual-interaction notification with no retry, a real import failure →
  retry, a client-level failure → remove + retry); `cleanupStalledDownloads` and
  `pruneOldFailedQueueItems`'s threshold-based cleanup; `retryFailedGrab`'s blocklist-then-retry
  chain (respecting `blocklistOnly` and the configured retry cap); `checkHealthAndNotify`'s dedup-
  against-the-last-notified-summary behavior; `runSeedGoalCleanup`; and `startScheduler`'s job-
  registration wiring (30+ unique job keys, started exactly once). `indexerClient.js`,
  `downloadClient.js`, `notifications.js`, `metadata.js`, `upgradeCandidates.js`, and `jobRegistry.js`
  are mocked (the last one specifically to prevent `startScheduler()`'s test from starting real cron
  timers); `importer.js` is partially mocked via `importOriginal` to keep the real `ImportSkippedError`
  class for `instanceof` checks; everything else (quality scoring, release parsing, blocklist,
  release-group stats, root-folder-quota checking) runs for real.

  Six distinct bugs surfaced via the first Docker run, all in the test's own fixtures, none in the
  source: a hardcoded `indexerId: 1` on the shared fake-result fixture violated `queue.indexer_id`'s
  real FK (nothing in these tests needed a real indexer row, so it's `null` now); three assertions
  expected a download-client's `category` field as `undefined` where the real DB-mapped client
  actually has `null` (and `expect.anything()` explicitly excludes `null`, so it silently masked the
  same mismatch rather than catching it); the root-folder-quota test assumed `isRootFolderOverQuota`
  reads the `disk_usage_samples` table, when it actually calls `fs.statfsSync` on the folder's real
  path directly and additionally requires `pause_grabs_at_quota` to be set — an entirely different
  mechanism from `checkHealthAndNotify`'s own (real) low-disk-space check, which does read that
  table; a stalled-download fixture compared a JS `toISOString()` timestamp against SQLite's own
  `datetime()`-formatted column, two different string formats that don't reliably compare
  lexicographically; a `mockRejectedValueOnce`/`mockResolvedValueOnce` pair assumed call order would
  match the input array's order, but the array's first target (a nonexistent media item) never
  reaches the mock at all — the same ordering pitfall this project's own memory already flagged from
  Round 243, now hit a second time and fixed by branching the mock on the actual query content
  instead of call order; and a test asserting `sizeWithinQualityBounds` rejects an implausibly small
  "1080p" release turned out to test a scenario that can't happen with no size bounds configured for
  that quality (a settings-driven cache) — rewritten to assert the real, opposite default instead.

Test count: 1011 → 1070 (87 → 88 files).

Verified: `tsc --noEmit` clean, all 1070 server tests passing. No Docker rebuild — test-only change
(the new `export` keywords add no behavior).

## Round 274 — more test coverage (download clients) + a real Soulseek bug fix
The third-largest file tackled this session (1203 lines, 9 distinct download-client backends
behind one shared interface) — and this round did find a real, shipped bug, not just add tests.

- **Fixed**: `SlskdAdapter`'s `downloadId` (in both `addDownload` and `getStatus`) joined the
  Soulseek username and filename with a literal embedded NULL byte (`\x00`) instead of a space —
  confirmed via a hex dump of the actual source file, not a guess (`grep` had been silently
  reporting `downloadClient.ts` as a "binary file" for several rounds now, which was the real tell
  in hindsight). Both sides of the adapter's own internal comparison used the same corrupted
  template, so it likely went unnoticed in casual use — but a `TEXT` column bound with an embedded
  NULL byte is exactly the kind of value some SQLite drivers silently truncate at the C-string
  boundary, which would have desynced a stored `queue.download_id` from what `getStatus` computes
  on every poll, breaking progress/completion tracking for Soulseek downloads specifically. Caught
  only because this round's test asserted the exact string rather than a looser shape.
- `tests/downloadClient.test.ts` — `applyRemotePathMapping` (longest-prefix-wins, case-insensitive
  and mixed-slash-tolerant matching, unmapped passthrough); `testDownloadClientConnection`'s per-
  type checks; `removeQueueItemDownload`'s best-effort contract; and, for each of the 9 adapters
  behind `getDownloadClientAdapter`: qBittorrent (session-cookie caching and its drop-and-retry-once
  on a 403, `content_path`/`save_path` fallback, health-stats ratio math, and `removeSeededTorrents`'
  state+goal filtering), SABnzbd (its whole reason for existing — a 100%-in-queue job reported as
  "downloading", never "completed", until it actually reaches history — and trying both the queue
  and history locations to remove a job), the in-process Http and yt-dlp adapters (background
  download/spawn, stdout progress parsing, exit-code and spawn-error handling, and yt-dlp's opt-in
  flags), the three debrid adapters — Real-Debrid, TorBox (including its 0–100-vs-0–1 progress-
  normalization quirk), and AllDebrid, which got the most attention given its rich documented bug
  history: reading an accepted upload's id from `magnets[]` for a magnet vs. `files[]` for a
  `.torrent`-bytes upload, `data.magnets` coming back as a bare object instead of an array on the
  v4.1 status endpoint, and the dedicated `/magnet/files` recursive file-tree walk (a real file
  nested one folder deep, alongside a malformed sibling entry with neither a link nor children,
  proving both the recursion and the "just skip it" tolerance) — Blackhole's magnet/NZB/torrent
  content-sniffing, and Slskd's transfer-matching (the bug above, plus state-string mapping).
  `node:child_process` is partially mocked (`importOriginal`, overriding only `spawn` — a full
  replacement broke `ffprobe.ts`'s unrelated `execFile` import, loaded transitively via the full
  app); everything else runs for real. Several of this round's own test-fixture bugs surfaced via
  the first Docker run too: a `remote_path_mappings` FK violation from literal (nonexistent) client
  ids, a fake file response missing `.headers` that `HttpDownloadAdapter` reads for content-length,
  output-file assertions checking the wrong directory (Real-Debrid/AllDebrid/Http all write to the
  real `config.downloadsDir` directly, never the `test-fixtures` subfolder used for input fixtures),
  a multi-file AllDebrid fixture reusing one mocked `Response`'s already-consumed stream for a
  second download, and an AllDebrid `/link/unlock` mock not wrapped in the `{status, data}` envelope
  `this.call()` actually unwraps.

Test count: 957 → 1011 (86 → 87 files).

Verified: `tsc --noEmit` clean, all 1011 server tests passing. Docker images rebuilt and pushed
(`server` and `combined` — the fix is server-only; `web` is unaffected).

## Round 273 — more test coverage (file placement & import engine)
No behavior changes. Continues the test-coverage push. The second-largest file tackled this
session (1194 lines) — the engine that actually moves a downloaded file into the library, names it,
and updates the database, shared by the automatic post-download path and every manual-import route.

- `tests/importer.test.ts` — `removeEmptyParents` (walks upward removing now-empty directories,
  stopping at the root folder); `createLibraryFolderSkeleton`'s never-throws contract;
  `findDownloadedFile`'s full matching engine (plain token-overlap scoring and its 0.4 confidence
  floor, narrowing to a specific season/episode or air date in a season-pack download, falling back
  to plain overlap when nothing parses to the exact target, and `searchRoot` — a single file used
  directly, a directory scoped and scored on its own, and falling through to the full downloads
  directory when a stale mapping no longer exists) and `listDownloadedFileCandidates`'s newest-first
  listing; `placeFile` across all three shapes it handles (single, episodic — including the
  absolute-episode-number count that deliberately excludes season 0 specials — and single-file
  collection), its guards (no root folder, the free-space check), imported-vs-upgraded notification
  choice, conditional NFO sidecar writing, comic image conversion, and video-only subtitle
  downloading (proven for both directions — a provider IS queried for a video file, and never for a
  non-video one, rather than only checking the negative case, which a provider-less first draft would
  have left vacuously true either way); `placeAlbumFiles` (leading-number track matching, an
  unmatched file keeping its original name, the CD1/CD2 multi-disc collapse into one album with a
  continuous cross-disc track-number offset, and conditional audio-tag writing); `placeSeasonPackFiles`
  (importing every file it can match to a known episode, leaving an unmatched one in place rather
  than guessing, and throwing when nothing in the pack matches at all); `importQueueItem`'s dispatch
  to the right placement function by shape, its manual-source-file path-containment validation, and
  its conditional download-client removal / source-folder cleanup (never touching the source for a
  hardlink/symlink strategy); and `renameLibraryFiles`/`renameOneMediaItem` (a real rename when the
  computed destination differs, a no-op when it's already correct, `dryRun` touching neither the
  filesystem nor the database, skipping items with no file, counting-but-not-renaming Music, and one
  item's rename failure not aborting the batch). `notifications.js`, `metadataExport.js`,
  `audioTagWriter.js`, `archiveExtract.js`, `downloadClient.js`, `subtitleSync.js`,
  `comicImageConvert.js`, and `ffprobe.js` are mocked; `subtitleClient.js` is partially mocked
  (keeping the real, already-tested `pickBestSubtitleForLanguage`); everything else (naming,
  mediaTypes, settingsStore, releaseParser, `libraryScan.js`'s `detectSeasonEpisode`,
  `releaseGroupStats.js`) runs for real.

  The most consequential discovery this round wasn't in the source: `config.downloadsDir` is a
  `const` resolved once at `config.ts`'s module-load time from `AONARR_DOWNLOADS_DIR` — reassigning
  that env var per test after the module has already loaded (as the first draft did) has no effect
  at all, so every `findDownloadedFile`-family test silently searched the wrong directory and found
  nothing. Worse, `setupTestDb()` points `AONARR_CONFIG_DIR` and `AONARR_DOWNLOADS_DIR` at the exact
  same temp directory, so a naive "clear everything in the downloads dir between tests" fix deleted
  the app's own `logs/` folder and crashed the logger mid-suite. The real fix: read the actual
  resolved `config.downloadsDir` once in `beforeAll` and use a dedicated subfolder under it for every
  test's fixtures — but even that subfolder isn't safe to merely *clear*, since
  `cleanupDownloadSourceFolder`'s own `removeEmptyParents` call walks upward from a just-removed
  release folder toward the real `config.downloadsDir` and will happily remove that subfolder too, as
  a legitimate "now-empty parent" — so each test recreates it outright (`rmSync` + `mkdirSync`) rather
  than assuming it still exists.

Test count: 910 → 957 (85 → 86 files).

Verified: `tsc --noEmit` clean, all 957 server tests passing. No Docker rebuild — test-only change.

## Round 272 — more test coverage (library scan & import engine)
No behavior changes. Continues the test-coverage push. The single largest and most historically
bug-dense file tackled this session (963 lines) — the core Scan & Import engine behind every media
shape (movie, series, author/book, audiobook).

- `tests/libraryScan.test.ts` — the pure helpers (`titlesMatch`'s exact-only matching, specifically
  re-proving the documented "Extraction"/"Extraction 2" and "The Office"/"The Office UK" regression
  it exists to prevent; `guessTitleFromText`'s cut-pattern precedence; `detectSeasonEpisode`'s
  filename-first/season-folder-fallback chain), then `scanAndImportLibrary` across all three shapes:
  movie (create, match-and-fill an existing missing item, and — the exact historical "duplicate
  movies" bug the source comments describe — never duplicating or overwriting an already-downloaded
  movie when a second file guesses the same title), series (new-show creation with best-effort
  metadata enrichment, matching an existing show instead of duplicating it, the Season-folder+bare-
  E-marker fallback, not overwriting an episode that already has a different file, and — another
  named historical bug — the has_file rollup that flips a parent series from "Missing" to correct
  even on a run that finds zero new files), author/book (parent+child creation, the "sits directly in
  root with no parent folder" skip), and audiobook (per-file track upserting, a flat Artist/track.mp3
  layout falling back to a self-titled album, and the multi-disc "Album [2CD]/CD1,CD2" layout being
  recognized as ONE album with continuous track numbering — proving the exact disc-restart-collision
  logic `upsertTrackFromFile`'s own comment describes); the `onlyTitle`/`onlySeasonNumber`/
  `onlyMediaItemId` per-item scoping (including the documented "The Office" vs "The Office (US)"
  loose-vs-strict-match scenario); the overlapping-whole-library-scan guard (and its deliberate
  exemption for a scoped per-item scan); a genuine mid-scan `AbortSignal` stop; and one file's
  exception not aborting the rest of the batch. Then `refreshLibraryMetadata`/`refreshOneMediaItem`
  (the already-matched-vs-never-matched title-overwrite gate, episode/child backfilling, placeholder-
  episode-title replacement, a movie's studio backfill, and `onlySeasonNumber` leaving the show's own
  fields untouched) and the two startup data-fix backfills. `metadata.js`'s six network-calling
  exports and `ffprobe.js`'s `probeMediaInfo` are mocked; everything else runs for real against a
  real temp-directory filesystem tree and a real DB, wiped between tests since this file's every
  function re-scans the whole table for its type.

  Four bugs caught via the first Docker run, none in the source: three tests used a fictional
  `'book'` media type key — the real registered key is `'author'` (Books shape, per
  `mediaTypes.ts`) — the exact same mistake this project's own memory already flagged from an
  earlier round, now recorded more prominently since it recurred independently; and one test's raw
  SQL `INSERT` had its column list and `VALUES` list out of alignment (`overview`'s value landed in
  the `has_file` column), caught by an assertion receiving `"1"` where a string overview was
  expected.

Test count: 856 → 910 (84 → 85 files).

Verified: `tsc --noEmit` clean, all 910 server tests passing. No Docker rebuild — test-only change.

## Round 271 — more test coverage (Plex/Jellyfin/Emby media server client)
No behavior changes. Continues the test-coverage push.

- `tests/mediaServer.test.ts` — `getMediaServerConfig`'s missing-field guard and trailing-slash
  normalization; `fetchWatchedFiles`/`fetchAllLibraryFiles` for both Plex (movie/show section
  filtering, the watched-state gate, a failed section's items request being skipped rather than
  fatal) and Jellyfin/Emby (collapsing the same shared-household file across multiple users to the
  most-recently-played entry, the `/emby` base path); `parsePlexExternalIds`'s new-agent `Guid`-array
  vs. legacy `guid`-string parsing and their precedence; `fetchMediaServerMovies`/
  `fetchMediaServerSeries` for both platforms, including a behavior easy to miss reading either
  function in isolation — Plex silently skips a section whose items request fails, but Jellyfin/Emby
  *throws* on the equivalent failure, a real, deliberate asymmetry now pinned down by a test; Plex's
  shows-then-episodes two-pass fetch linking episodes to their show via `grandparentRatingKey`; and
  Jellyfin/Emby's own only-the-first-user behavior; `refreshMediaServerLibrary`'s per-path targeted
  Plex refresh vs. `triggerFullMediaServerScan`'s whole-section refresh (no `path` param), both
  platforms' best-effort never-throws contract even when the request itself throws;
  `resolvePlexFilePath`'s metadata-lookup unwrapping; and `pushWatchState`'s Plex scrobble/unscrobble
  and Jellyfin/Emby PlayedItems POST/DELETE, both matched by `pathTail` across genuinely different
  mount-point prefixes with identical trailing segments — the precise pitfall flagged in this
  project's own testing conventions memory, deliberately exercised rather than accidentally dodged.

Test count: 822 → 856 (83 → 84 files).

Verified: `tsc --noEmit` clean, all 856 server tests passing. No Docker rebuild — test-only change.

## Round 270 — more test coverage (import lists: Trakt/IMDb/Last.fm/TMDB)
No behavior changes. Continues the test-coverage push.

- `tests/importLists.test.ts` — `passesListFilters`'s rating/votes/genre gates (never rejecting on
  unknown data, case-insensitive genre exclusion, tolerating malformed `exclude_genres` JSON) and
  `insertTracksForAlbum`'s never-throws contract; then, for all four list sources dispatched by
  `syncImportList` — Trakt (list vs. watchlist URL routing, adding a new movie/series with the
  series' episodes fetched, per-hour dedup by tmdb id, exclusion, filter rejection, `require_review`
  queuing, and one malformed entry not aborting the rest of the batch), IMDb (its public per-list CSV
  export — including a quoted, comma-containing field, the exact scenario `splitCsvLine`'s own doc
  comment calls out — duplicate-in-library skip, no-metadata-match queuing for review, and a
  successful match's fields coming from the search result rather than the raw CSV row), Last.fm
  (bare-username vs. full-profile-URL parsing, and the single-artist-object-instead-of-an-array
  response shape its top-artists endpoint can return), and TMDB (bare-id vs. full-URL parsing,
  `media_type` vs. the `first_air_date` fallback heuristic for movie/TV detection, and its own
  genre-id-to-name mapping feeding into the shared filter) — each source's config-missing and non-OK-
  response error paths, plus `syncImportList`'s own persistence of `last_synced_at`/`last_added_count`/
  `last_error` on both success and failure, and `runAllImportLists`' enabled-only filtering and a
  genuine mid-loop `AbortSignal` stop (proven by aborting from inside the first list's own mocked
  fetch call, not just before the run starts). `metadata.js`'s four network-calling exports are
  mocked (closure-indirection, same pattern as Round 246); `importExclusions.js`/`duplicateCheck.js`/
  `importReview.js` all run for real against the test DB, being cheap DB-only siblings.

  Three bugs caught and fixed before or via the first Docker run: a missing `beforeEach` import
  (caught immediately by the run); a CSV test-fixture helper that didn't quote fields containing
  commas, which would have silently misaligned every column after "Num Votes"/"Genres"; and the
  `runAllImportLists` tests originally reading the *entire*, unscoped `import_lists` table built up
  by 15+ earlier tests in the same file — fixed with a local `beforeEach` that wipes the table first,
  the same shared-state lesson as `subtitleRescan.test.ts` and others before it.

Test count: 787 → 822 (82 → 83 files).

Verified: `tsc --noEmit` clean, all 822 server tests passing. No Docker rebuild — test-only change.

## Round 269 — more test coverage (indexer search client)
No behavior changes. Continues the test-coverage push. First of the genuinely large remaining
service files (443 lines) — the rest (`downloadClient`, `importLists`, `importer`, `libraryScan`,
`mediaServer`, `metadata`, `scheduler`) are all substantially bigger still.

- `tests/indexerClient.test.ts` — `checkIndexerHealth`'s caps-endpoint vs. direct-URL check per
  protocol, its three outcome shapes (ok, HTTP-status failure, thrown-error failure), and backing off
  entirely once a real 429 has been recorded; `searchIndexer`'s three protocol adapters — Torznab/
  Newznab XML parsing (category fallback to the media type's default, the full torznab:attr
  extraction including deriving `leechers` from `peers - seeders` only when no explicit leechers attr
  is present, the enclosure-vs-`<link>` download-URL fallback, protocol-to-torrent/usenet mapping),
  plain RSS (client-side case-insensitive title filtering, skipping an item with no resolvable URL),
  and the generic DDL JSON adapter (config validation, `{query}` substitution, dot-path field mapping,
  skipping an item missing its title/URL) — plus the 429 backoff and proactive per-hour query-limit
  gates (the latter counting failed attempts against the cap, same as a successful one); and
  `searchAllIndexers`'s orchestration: filtering to enabled indexers whose `mediaTypes` match, sorting
  combined results by seeders descending, one indexer's failure never blocking another's results, and
  the scene-name-variant fallback (tried only when the literal query returns nothing, stopping at the
  first variant that works) — this last one caught a case-sensitivity bug in the test's own fixture
  before it ever ran: `generateSceneVariants`'s `&`→"and" swap is a literal lowercase substitution
  ("Mr and Mrs Smith"), not the capitalized guess the first draft assumed.

Test count: 753 → 787 (81 → 82 files).

Verified: `tsc --noEmit` clean, all 787 server tests passing. No Docker rebuild — test-only change.

## Round 268 — more test coverage (subtitle search/download clients)
No behavior changes. Continues the test-coverage push.

- `tests/subtitleClient.test.ts` — `searchSubtitles`'s OpenSubtitles request shape (query/languages
  params, the optional hearing-impaired/foreign-parts-only filters, the Api-Key header) and response
  mapping (the release-name fallback chain: `release` → `feature_details.title` → the queried file
  name; booleans coerced from OpenSubtitles' raw fields); `pickBestSubtitle`'s full ranking algorithm
  (a movie-hash match always wins regardless of popularity, otherwise highest `downloadCount` wins
  with a missing count treated as 0, a "custom" provider result is eligible despite a null `fileId`,
  and the input array is never mutated) and `pickBestSubtitleForLanguage`'s per-language scoping;
  `downloadSubtitleContent`'s two-step POST-for-a-signed-link-then-fetch-it handoff and all three of
  its failure modes; `searchCustomSubtitles`'s generic dot-path JSON adapter (`{query}`/`{languages}`
  template substitution, the Bearer header only when an API key is configured, resolving the results
  array via a configured dot path or the response body itself when unconfigured, field-mapping via
  dot path with "unknown"/the queried file name as defaults, and silently skipping an item whose
  download-URL field doesn't resolve); and `downloadSubtitleFromUrl`'s direct fetch-and-return-text.
  Genuinely zero-import aside from global `fetch`, so no `setupTestDb()` needed.

Test count: 725 → 753 (80 → 81 files).

Verified: `tsc --noEmit` clean, all 753 server tests passing. No Docker rebuild — test-only change.

## Round 267 — more test coverage (hand-rolled IRC client)
No behavior changes. Continues the test-coverage push.

- `tests/ircClient.test.ts` — `IrcConnection` against a real local `net.createServer` standing in
  for an ircd (same reasoning as `smtp.ts`'s own tests — a hand-rolled protocol client built
  directly on sockets is best proven against a real socket, not a guess at what a mocked one should
  emit): NICK/USER registration and JOIN once welcomed, replying to a server PING with a matching
  PONG, the full SASL PLAIN exchange (CAP REQ/ACK, the base64 `\0user\0pass` payload decoded and
  verified, 903 success), SASL being skipped without blocking registration on a CAP NAK, SASL
  failing via a 904 reply after a full AUTHENTICATE round-trip, PRIVMSG routing (matched case-
  insensitively against the configured channel, ignoring a PRIVMSG to a different channel or to the
  bot's own nick), and the automatic-reconnect behavior after the server drops the connection
  (versus never reconnecting once `stop()` has been called). The reconnect test mixes real socket
  I/O with fake timers (`toFake: ["setTimeout", "clearTimeout"]` only, so the actual TCP handshake
  keeps running for real) — the first version raced the real close-event propagation against
  advancing the fake clock and hung until Vitest's own timeout, fixed by spying on `log.warn` and
  polling via `setImmediate` (never faked) until the reconnect's own `setTimeout` call is confirmed
  registered before advancing it. TLS (`useSsl: true`) is left untested — the branch is a one-line
  `tls.connect` vs `net.connect` choice, not worth a full TLS handshake fixture for this round.

Test count: 717 → 725 (79 → 80 files).

Verified: `tsc --noEmit` clean, all 725 server tests passing. No Docker rebuild — test-only change.

## Round 266 — more test coverage (Soulseek/slskd search client)
No behavior changes. Continues the test-coverage push.

- `tests/soulseek.test.ts` — `encodeSlskdDownloadUrl`/`decodeSlskdDownloadUrl`'s round-trip fidelity
  (including usernames/filenames needing URI-escaping — spaces, parens, unicode) and both malformed-
  URL error cases (missing username, missing filename); `searchSlskd`'s full async poll loop under
  `vi.useFakeTimers()` + `advanceTimersByTimeAsync` — creates a search, polls until `isComplete`,
  then fetches and maps responses into `SearchResult[]` (title reduced to the basename across both
  `/` and `\` separators, `seeders` derived from `hasFreeUploadSlot`); the https-scheme/API-key-
  header request shape; a single non-OK poll response being skipped rather than aborting the search;
  giving up politely and still returning gathered responses once the real 15-second deadline is
  exceeded; and the three failure modes (search-creation request failing, no search id returned, the
  final responses fetch failing). One test initially left a real unhandled-rejection window — the
  fake-timer advance drove the promise to rejection before the next line could attach `.rejects` —
  fixed by attaching the rejection expectation immediately after the call, before advancing timers.

Test count: 706 → 717 (78 → 79 files).

Verified: `tsc --noEmit` clean, all 717 server tests passing. No Docker rebuild — test-only change.

## Round 265 — more test coverage (course landing-page scraping)
No behavior changes. Continues the test-coverage push.

- `tests/courseScraper.test.ts` — `scrapeCoursePage`'s URL validation (a non-URL string, a non-
  http(s) protocol), network-failure handling (`fetch` itself throwing, a non-OK HTTP status), and
  title extraction (og:title preferred over `<title>`, falling back to `<title>` when og:title is
  absent, throwing when neither is present, HTML entity decoding for both named and numeric
  entities, and the edX-only "| edX" suffix stripping — confirmed to NOT apply to a similarly-shaped
  suffix on a non-edX hostname). Also covers `extractMetaContent`'s two documented robustness cases:
  a `content` attribute appearing before `property`/`name` in the tag, and a double-quoted content
  value containing an internal apostrophe not getting cut short — the exact scenario called out in
  the source's own comment. Genuinely zero-import aside from global `fetch`, so no `setupTestDb()`
  needed.

Test count: 691 → 706 (77 → 78 files).

Verified: `tsc --noEmit` clean, all 706 server tests passing. No Docker rebuild — test-only change.

## Round 264 — more test coverage (realtime SSE, Prowlarr/Jackett indexer sync)
No behavior changes. Continues the test-coverage push.

- `tests/realtime.test.ts` — `realtime.ts`'s SSE broadcast channel: only currently-registered
  clients receive a broadcast, an immediate broadcast fires when nothing has been sent recently, a
  burst of rapid calls coalesces into exactly one broadcast after the 1500ms cooldown window (proven
  by asserting the write count is exactly 1, not 2, after advancing fake timers — 2 would mean a
  second timer was wrongly scheduled), and a write failure on one half-closed client doesn't throw or
  stop the broadcast from reaching the others. Genuinely zero-runtime-import (only an erased `import
  type` from `express`), so no `setupTestDb()` needed — but the module's own `lastSentAt`/
  `pendingTimer` state persists across tests in the file, so each test jumps fake system time far
  past the cooldown window first and flushes any pending timer in `afterEach` to guarantee the next
  test starts clean.
- `tests/prowlarrSync.test.ts` / `tests/jackettSync.test.ts` — both sync services' shared shape: a
  config-missing guard that never calls `fetch` at all, an HTTP-error-status response, a
  request-level network error, a real API-key-header request, inserting a new `indexers` row per
  returned entry (protocol mapping and proxy-URL construction verified), updating rather than
  duplicating an existing row on re-sync (matched by the indexer id stashed in `config`), and one
  malformed indexer (a real `indexers.name` NOT NULL violation) getting logged and skipped without
  aborting the rest of the batch. `prowlarrSync.test.ts` additionally targets the exact concern its
  own source comment calls out: a numeric id search is terminated with the JSON's closing brace so
  indexer id 5 can't accidentally match an already-synced row for id 50 or 500 — verified by syncing
  ids 9250 and 92500 first, then confirming a later sync of 925 creates a genuinely new third row
  instead of updating either. `jackettSync.test.ts` covers its own distinct shape instead (string
  slug ids quoted in the stored JSON, `encodeURIComponent`-escaping an id into the per-indexer proxy
  path, `enabled` always forced to 1 rather than read from the API response).

Test count: 672 → 691 (74 → 77 files).

Verified: `tsc --noEmit` clean, all 691 server tests passing. No Docker rebuild — test-only change.

## Round 263 — more test coverage (ffprobe media analysis)
No behavior changes. Continues the test-coverage push.

- `tests/ffprobe.test.ts` — `probeMediaInfo` against `node:child_process`'s `execFile` mocked to
  return controlled ffprobe-shaped JSON: basic field extraction (codecs, resolution, duration,
  bitrate, bit depth), fractional frame-rate parsing (`24000/1001` → `23.98`) including the `0/0`
  divide-by-zero guard, graceful nulls for an audio-only file with no video stream, multi-stream
  audio/subtitle extraction (language, bitrate, default/forced flags), and the full HDR/Dolby Vision
  detection matrix — plain HDR10 (PQ transfer), HLG, HDR10+ (side-data), single-layer Dolby Vision
  (both the DOVI-config-record and codec-tag-string signaling paths), dual-layer Dolby Vision with
  an HDR10 base layer, plain SDR, and the "unknown transfer function" fallback — as well as the
  one-retry-then-give-up behavior on a transient "moov atom not found"-style error (succeeding on
  the second attempt, and returning `null` if the retry also fails), no retry at all for a
  non-transient error (e.g. ffprobe itself missing), and a `null` return instead of a throw on
  unparseable JSON output. The "no retry" and "exactly one retry" claims are backed by an explicit
  `execFile` call counter rather than queue-length alone — a queue-length check can't actually prove
  it, since `Array.shift()` on an empty queue is a silent no-op.

Test count: 653 → 672 (73 → 74 files).

Verified: `tsc --noEmit` clean, all 672 server tests passing. No Docker rebuild — test-only change.

## Round 262 — more test coverage (audiobook chapter merging)
No behavior changes. Continues the test-coverage push.

- `tests/audiobookConvert.test.ts` — `convertSubItemToM4b`'s full validation chain (sub-item not
  found, no downloaded folder yet, fewer than 2 downloaded tracks, a track file missing on disk,
  ffprobe unable to read a duration, and the output-path-collides-with-a-source-track guard), then
  the success path against real track files on disk: the ffmpeg args include every input track and
  the chapter metadata file, the DB transaction correctly replaces N per-track rows with one merged
  row (summed `duration_seconds`, `track_number` reset to 1), the original track files get deleted,
  and the temp chapter-metadata file is cleaned up in both the success case and when ffmpeg itself
  fails — the latter also confirming a failed merge never touches the database or deletes anything.
  `ffprobe.js`'s `probeMediaInfo` and `node:child_process`'s `execFile` (ffmpeg) are both mocked;
  `metadataExport.js`'s `safeFileName` runs for real.

Test count: 643 → 653 (72 → 73 files).

Verified: `tsc --noEmit` clean, all 653 server tests passing. No Docker rebuild — test-only change.

## Round 261 — more test coverage (CBZ comic image re-encoding)
No behavior changes. Continues the test-coverage push.

- `tests/comicImageConvert.test.ts` — `convertComicImages` against real `adm-zip`-built CBZ
  fixtures (`node:child_process`'s `execFile` mocked to stand in for ffmpeg): the CBR/RAR rejection,
  a no-op for an archive with no image entries, re-encoding to both WebP and JPEG with the pages
  correctly renamed, non-image entries (a `ComicInfo.xml`) left untouched alongside converted pages,
  and — the fix this file's own history is built around — two pages that only differ by original
  extension (`page01.png`/`page01.jpg`) both mapping to `page01.webp` get disambiguated
  (`page01-2.webp`) instead of one silently overwriting the other. `convertComicImagesBestEffort`'s
  three ways of not throwing (success, an unsupported extension, an ffmpeg failure mid-conversion)
  round it out.

Caught the same convention slip flagged in Round 251's memory update before this file ever ran:
`comicImageConvert.ts` imports `logger.js`, which touches `config.js`/`db/index.js` transitively —
the first draft skipped `setupTestDb()` entirely. Fixed before the first run, the same way and for
the same reason as `subtitleSync.test.ts` — every file needs its imports checked for this, not just
the ones that look database-adjacent at a glance.

Test count: 633 → 643 (71 → 72 files).

Verified: `tsc --noEmit` clean, all 643 server tests passing. No Docker rebuild — test-only change.

## Round 260 — more test coverage (Radarr/Sonarr/Lidarr one-time library migration)
No behavior changes. Continues the test-coverage push.

- `tests/starrImport.test.ts` — `fetchRadarrMovies`' file-path derivation (a direct `movieFile.
  path`, a `path` + `movieFile.relativePath` combination, and the `radarr:<tmdbId>` fallback id for
  a monitored-but-undownloaded movie) and its skip of entries with no title. `importArtistsFromLidarr`
  exercising the Lidarr/Readarr-shared `importCollectionData` matching core: creating a new parent
  and child, matching an existing parent by external id (even under a renamed title) or by exact
  title, coalescing a matched parent's missing fields without overwriting existing ones, skipping a
  child whose derived path tail is already tracked, updating a previously-fileless child once a real
  path appears, and never resetting an already-downloaded child back to missing when Lidarr no
  longer reports a file for it.

Caught three real bugs in the test before any of them passed, none of them subtle mock issues —
genuine gaps in understanding the source's actual behavior: (1) `root_folder_id` is a real foreign
key, and a literal `1` only works if a root folder with that id exists — fixed by inserting one for
real. (2) The most consequential one: `importCollectionData` never iterates parents directly — it
only ever resolves one as a side effect of processing a child that references it, so a Starr artist
with zero albums in the mocked response is completely invisible to the matching logic, and two
tests asserting on parent-matching with no album fixture were passing vacuously (nothing was ever
touched) rather than proving anything. Fixed by giving every parent-matching test at least one
child. (3) `pathTail` keeps only the last 3 path segments, and Lidarr-derived children are always
stored as a *folder* path, not the track file itself — a naive same-tail fixture pairing a filename-
terminated existing path against a freshly-derived folder path silently fails to collide, since the
segment 3 levels up differs by construction. Fixed by aligning both fixtures on folder paths that
share their last 3 segments, isolating the "different mount point" difference to a segment outside
that window — which is the actual case the test means to cover.

Test count: 623 → 633 (70 → 71 files).

Verified: `tsc --noEmit` clean, all 633 server tests passing. No Docker rebuild — test-only change.

## Round 259 — more test coverage (book ISBN scanning)
No behavior changes. Continues the test-coverage push.

- `tests/bookIsbnScan.test.ts` — `findIsbnInText`'s checksum-validated ISBN-10/13 extraction
  (labeled, bare, hyphenated, and the ISBN-10→13 conversion), all grounded against a real published
  book's genuine ISBN-10/13 pair rather than an invented one, plus a rejected checksum-invalid
  number. `extractIsbnFromBookFile`'s epub path against real `adm-zip`-built EPUB fixtures (a valid
  container.xml/OPF pair, a missing container.xml, an OPF with no `dc:identifier`, and a corrupt
  non-zip file) — no mocking needed, since `xml2js`/`adm-zip` are simple enough to exercise for
  real. The unsupported-extension short-circuit and the "never throws" contract for a `.pdf` that
  `pdf-parse` can't actually parse round it out, along with `fetchBookByIsbn`'s Open Library
  mapping (including its medium-then-large cover fallback) and error handling.

Test count: 606 → 623 (69 → 70 files).

Verified: `tsc --noEmit` clean, all 623 server tests passing. No Docker rebuild — test-only change.

## Round 258 — more test coverage (AI provider HTTP client)
No behavior changes. Continues the test-coverage push.

- `tests/aiClient.test.ts` — `queryAi`'s two backends: Ollama's native chat API (`/api/chat`,
  trailing slash stripped, an `images` array added only when a frame is supplied, Authorization
  only sent when an api key is configured) and the OpenAI-compatible chat-completions shape
  (`/chat/completions`, an `image_url` data-URI content part added for vision requests), plus both
  backends' error handling — a non-ok response throwing with the status code, the cloud path also
  surfacing the provider's own error message when the error body parses as JSON and degrading
  gracefully when it doesn't, and an unexpected response shape (missing message content) throwing
  a clear error instead of returning `undefined`. No database at all in this file's own import
  chain, so — unlike nearly every other file this session — a plain static import and zero
  `setupTestDb()` call; the whole file runs in single-digit milliseconds.

Test count: 595 → 606 (68 → 69 files).

Verified: `tsc --noEmit` clean, all 606 server tests passing. No Docker rebuild — test-only change.

## Round 257 — more test coverage (AI-assisted media identification)
No behavior changes. Continues the test-coverage push.

- `tests/aiIdentify.test.ts` — `identifyMediaFile`'s provider resolution (no provider configured,
  a specifically-requested provider that's disabled, the default provider versus an explicitly
  requested non-default one), and its three-way prompt strategy: a vision prompt built from an
  extracted video frame, a text prompt built from an audio file's embedded tags, and the filename-
  only fallback used both when frame/tag extraction fails *and* for any other file type outright.
  `aiClient.js`'s `queryAi` is mocked, and — using the same technique as Round 251's
  `subtitleSync.test.ts` — `node:child_process`'s `execFile` is mocked to drive both the genuine,
  environment-driven failure path (no `ffmpeg`/`ffprobe` in this container, so the fallback-to-
  filename behavior is exercised for real) and, by simulating a successful `ffmpeg`/`ffprobe` run,
  the frame-extraction and tag-extraction success paths that the missing binaries alone could never
  reach.

Test count: 586 → 595 (67 → 68 files).

Verified: `tsc --noEmit` clean, all 595 server tests passing. No Docker rebuild — test-only change.

## Round 256 — more test coverage (IRC feed connection lifecycle)
No behavior changes. Continues the test-coverage push.

- `tests/ircFeedManager.test.ts` — `restartIrcFeeds`'s config mapping from an `irc_feeds` row to a
  connection config (host/port/useSsl/nickname/channel), skipping disabled feeds, decrypting an
  encrypted `sasl_pass` versus passing a `null` one through untouched, stopping every previous
  connection before establishing new ones on a repeated call, the announce callback wiring
  (invoking it calls `handleAnnounce` with the right feed/text), and — the one worth calling out —
  that a `handleAnnounce` rejection never escapes as an unhandled promise rejection. `ircClient.js`'s
  `IrcConnection` and `ircAnnounce.js`'s `handleAnnounce` are both mocked.

Caught two real bugs in the test itself before it ever ran: the mock for `IrcConnection` (a class
the source instantiates with `new`) was first written as an arrow-function indirection, which
throws "is not a constructor" — fixed with a plain `function` wrapper instead, relying on the fact
that returning an explicit object from a constructor call overrides the implicit `this` regardless
of whether `new` was used internally. Separately, the first draft of the "rejection doesn't escape"
test only asserted the callback doesn't throw *synchronously* — which would have passed even if the
source's `.catch()` were deleted, since the wrapper never awaits `handleAnnounce()` and the
rejection only happens on a later microtask. Fixed by listening for a real `process`
`'unhandledRejection'` event instead, which actually proves the `.catch()` is doing its job.

Test count: 577 → 586 (66 → 67 files).

Verified: `tsc --noEmit` clean, all 586 server tests passing. No Docker rebuild — test-only change.

## Round 255 — more test coverage (scheduled subtitle rescan)
No behavior changes. Continues the test-coverage push.

- `tests/subtitleRescan.test.ts` — `rescanMissingSubtitles`'s gating (no enabled provider, a non-
  custom provider missing its api key, an empty configured-languages string), then the matching
  pass across single-shape items and episodes: video-extension filtering, skipping a `collection`-
  shaped type even with a path set, one download attempt per configured language, and that a
  thrown download error for one language doesn't stop the next language or item from still being
  attempted. `importer.js`'s `downloadSubtitleForLanguage` is mocked; everything else is real.

Caught the same class of bug flagged in earlier rounds' memory before this one ever ran:
`rescanMissingSubtitles` re-scans the *entire* library every call with no memory of prior runs, so
a movie or episode left behind by one test would be silently reprocessed by the next, corrupting a
"never called" or exact-call-count assertion. Fixed with a full `episodes`/`media_items`/
`subtitle_providers` wipe in `afterEach` rather than relying on unique fixture titles, since the
whole point of several of these tests is asserting on what the *entire table* contains.

Test count: 568 → 577 (65 → 66 files).

Verified: `tsc --noEmit` clean, all 577 server tests passing. No Docker rebuild — test-only change.

## Round 254 — more test coverage (TMDB/Last.fm recommendations, auto-request from watch history)
No behavior changes. Continues the test-coverage push — the session's first pass at
`recommendations.ts`, deferred twice earlier for its size (TMDB + Last.fm + media server + auto-
select-root-folder + metadata dependencies all in one file) until enough of the individual mocking
patterns below had been validated separately.

- `tests/recommendations.test.ts` — `getRecommendations`'s "because you added X" (TMDB/Last.fm
  similarity, seeded from the most recently added library items) and "because you watched X"
  (seeded from actual watch history instead) paths: empty output with no fetch calls at all when
  neither API key is configured, deduping a TMDB suggestion already in the library, honoring the
  exclusion list, correctly tagging watch-history-sourced suggestions with `basis: "watched"`, and
  Last.fm artist suggestions (mbid mapping, large-image extraction, case-insensitive dedup against
  owned artists). `runAutoRequestFromWatchHistory`'s gating (disabled, or no watched-basis
  candidates), respecting its configured limit, and never re-adding a tmdb id already in the
  library. `mediaServer.js` (`getMediaServerConfig`/`fetchWatchedFiles`) and `metadata.js`
  (`fetchSeriesEpisodesFor`) are mocked; the TMDB/Last.fm calls themselves go through
  `vi.stubGlobal("fetch", ...)` keyed by URL substring.

Caught one test-authoring bug before it ever passed: `getRecommendations()` calls
`fetchWatchedFiles()` twice per run (once each for the movie and series "watched" branches), but
three tests only queued a single `mockResolvedValueOnce` — the second call fell through to an
unconfigured mock returning `undefined`, and `undefined.length` threw inside
`recentlyWatchedLibraryItems`. Fixed by using a persistent `mockResolvedValue` instead, since the
series branch's response content didn't matter for these movie-focused tests anyway.

Test count: 558 → 568 (64 → 65 files).

Verified: `tsc --noEmit` clean, all 568 server tests passing. No Docker rebuild — test-only change.

## Round 253 — more test coverage (media server watch-event webhooks/sync)
No behavior changes. Continues the test-coverage push.

- `tests/mediaServerWebhook.test.ts` — Plex's scrobble-only webhook payload parsing (`mediaServer.
  js`'s `resolvePlexFilePath` mocked), Jellyfin/Emby's payload parsing (a pure function, run for
  real — including that a missing notification-type field is accepted rather than filtered, and
  the `Item.Path` fallback), `recordWatchEvent`'s path-tail matching across all three shapes
  (media_items/episodes/sub_items), and `syncWatchStatusFromMediaServer`'s batch cursor logic: no
  new watch events when nothing's newly watched, a matched file recorded and the cursor advanced to
  its timestamp, an *unmatched* file with a later timestamp never advancing the cursor past the
  last genuinely matched one, and an already-processed file (at or before the stored cursor) never
  reprocessed.

Test count: 541 → 558 (63 → 64 files).

Verified: `tsc --noEmit` clean, all 558 server tests passing. No Docker rebuild — test-only change.

## Round 252 — more test coverage (IRC instant-grab announce matching)
No behavior changes. Continues the test-coverage push — the most involved orchestrator tested yet.

- `tests/ircAnnounce.test.ts` — `handleAnnounce`'s full decision chain: an invalid or non-matching
  announce regex is a no-op rather than a throw, no download clients configured is a no-op, then
  the real matching pipeline for both movies and episodes — title matching, the already-queued
  check, allowed-quality filtering, blocklist filtering, and the minimum-custom-format-score gate —
  all running against a real database and the codebase's own already-tested pieces
  (`releaseParser`, `libraryScan`'s `titlesMatch`/`guessTitleFromText`, `customFormatScoring`,
  `blocklist`). Only `scheduler.js`'s `grab` is mocked, and via `importOriginal()` rather than a
  full module replacement, so `isAlreadyQueued` and `pickClientForProtocol` — both cheap and DB-
  or-pure — keep running for real instead of needing their own hand-written stand-ins.

Test count: 531 → 541 (62 → 63 files).

Verified: `tsc --noEmit` clean, all 541 server tests passing. No Docker rebuild — test-only change.

## Round 251 — more test coverage (subtitle timing sync)
No behavior changes. Continues the test-coverage push.

- `tests/subtitleSync.test.ts` — `syncSubtitleToVideo` on both paths: the genuine, environment-
  driven failure case (this container has no `ffsubsync` binary, so a real ENOENT proves the
  documented "never throws, keeps the original" contract, plus that the temp-file cleanup branch
  handles a temp file that was never created), and — via `vi.mock("node:child_process")` — the
  success path, where the mock simulates ffsubsync actually writing its output file before exiting
  0, proving the real rename-to-original and no-leftover-temp-file behavior.

Caught a real convention slip while drafting the test, before ever running it: `subtitleSync.ts`
imports `logger.js`, which touches `config.js`/`db/index.js` transitively to compute its log
directory — the first draft used a static top-level import with no `setupTestDb()` call at all,
which would have let those modules read whatever ambient config the container happened to have
instead of an isolated per-test temp dir. Fixed by adding `setupTestDb()` and switching to the
suite's usual dynamic-import-after-setup pattern before the test was ever run.

Test count: 527 → 531 (61 → 62 files).

Verified: `tsc --noEmit` clean, all 531 server tests passing. No Docker rebuild — test-only change.

## Round 250 — more test coverage (background job registry/scheduler)
No behavior changes. Continues the test-coverage push.

- `tests/jobRegistry.test.ts` — the shared cron/interval job registry underneath every scheduled
  background task: `registerJob` picking up a previously persisted schedule over the default,
  `runJobNow` recording success/error outcomes and refusing a second trigger while a job is still
  running, `cancelJob` aborting a running job's signal and the resulting status becoming
  "cancelled" once it settles, and `updateJobSchedule`'s validation for both cron (via `node-cron`'s
  own validator) and interval (whole seconds, 5s minimum) schedule types. Deliberately never calls
  `startAllJobs`/`startTask` directly — only `updateJobSchedule`'s own success path does, as a real
  side effect of a real `cron`/interval timer — so every test unconditionally calls the exported
  `stopAllJobs()` in `afterEach`, since `defs`/`state` are module-private and never reset between
  tests in the same file and an unstopped timer could otherwise fire into a later, unrelated test.
  Every test uses its own unique job key for the same reason.

Test count: 512 → 527 (60 → 61 files).

Verified: `tsc --noEmit` clean, all 527 server tests passing. No Docker rebuild — test-only change.

## Round 249 — more test coverage (media server library validation)
No behavior changes. Continues the test-coverage push.

- `tests/libraryValidation.test.ts` — `findLibraryMismatches` (`mediaServer.js`'s
  `fetchAllLibraryFiles` mocked, `archival.js`'s `pathTail` left real since it's a simple, already-
  understood helper): the empty-server-response short-circuit, matching/non-matching movies and
  episodes, the last-3-path-segments tail-matching heuristic tolerating both different mount-point
  prefixes and case differences between AoNarr's own path and the media server's, the episode
  label's `SxxEyy` formatting, that every single-shape type beyond just movie/series is checked
  (verified with `ppv`), and that a `collection`-shaped type (`author`) is never checked at all,
  even with fields deliberately set up to look like a mismatch — proving the type-scoping filter
  itself excludes it rather than relying on those fields never occurring together in practice.

Test count: 504 → 512 (59 → 60 files).

Verified: `tsc --noEmit` clean, all 512 server tests passing. No Docker rebuild — test-only change.

## Round 248 — more test coverage (Trakt list/watchlist sync)
No behavior changes. Continues the test-coverage push.

- `tests/traktSync.test.ts` — `runTraktSync`'s three-way enable gate, an unrecognized list URL
  format reported as an error without ever calling `fetch`, the URL-parsing branch that builds the
  right Trakt API path for a plain `/watchlist` versus a named `/lists/<slug>` URL, a failed Trakt
  request surfacing as an error rather than throwing, adding a movie/show (recording both its tmdb
  *and* trakt ids), the usual dedup/exclusion/no-id skip cases, a show still getting added when its
  episode fetch fails, and a non-movie/non-show list entry being ignored rather than crashing the
  rest of the sync — mirroring Round 247's `plexWatchlistSync.test.ts` closely, since the two
  services share nearly the same add-from-external-list shape.

Caught one test-authoring bug before it shipped: the "ignores a non-movie/non-show entry" test
reused the shared `movieEntry()` fixture helper with only its `title` overridden, leaving the
default `ids.tmdb` (4001) in place — which collided with an *earlier* test's already-inserted movie
using that same tmdb id, so the dedup check (keyed on tmdb id, not title) silently skipped it and
`added` came back 0 instead of the expected 1. Fixed by giving that entry its own unique tmdb id, a
reminder that overriding only the field a test cares about isn't enough when a shared fixture
helper's other defaults can collide with unrelated tests via the suite's shared-DB-per-file state.

Test count: 490 → 504 (58 → 59 files).

Verified: `tsc --noEmit` clean, all 504 server tests passing. No Docker rebuild — test-only change.

## Round 247 — more test coverage (Plex watchlist sync)
No behavior changes. Continues the test-coverage push.

- `tests/plexWatchlistSync.test.ts` — `runPlexWatchlistSync`'s three-way enable gate (sync off,
  media server not Plex, no token — each a no-op that never even calls `fetch`), a failed watchlist
  request surfacing as `{added: 0, error}` rather than throwing, adding a new movie/show (with the
  CDN-prefix-vs-already-absolute poster URL logic), skipping one already in the library or on the
  exclusions list, skipping an item with no matching external id, and a show still getting added
  even when fetching its episode list fails. `metadata.js`'s `fetchSeriesEpisodesFor` is mocked
  (same closure-indirection pattern as Round 246) while `mediaServer.js`'s `parsePlexExternalIds`
  and `importExclusions.js`'s `isExcluded` run for real — both are simple enough (a pure regex
  parser, a DB lookup already covered by its own test file) that mocking them would only have
  hidden real integration bugs for no benefit.

Test count: 480 → 490 (57 → 58 files).

Verified: `tsc --noEmit` clean, all 490 server tests passing. No Docker rebuild — test-only change.

## Round 246 — more test coverage (Overseerr/Jellyseerr webhook receiver)
No behavior changes. Continues the test-coverage push.

- `tests/overseerrWebhook.test.ts` — `handleOverseerrWebhook`'s full gate sequence (only
  MEDIA_APPROVED/MEDIA_AUTO_APPROVED act, an unrecognized `media_type` or missing `tmdbId` is
  reported back rather than throwing, and a tmdb id already in the library is declined *before*
  ever fetching metadata for it), then the success path for both movies and series — including
  that a series still gets added even when fetching its episode list fails, matching the source's
  deliberate `.catch(() => [])` around that call. This session's first `vi.mock()` of a *local*
  sibling module (`metadata.js`) rather than an npm package or the global `fetch` — the mock
  factory closes over module-scoped `vi.fn()`s via a thin indirection layer to sidestep vitest's
  hoisting of `vi.mock()` above the `const` declarations it would otherwise reference.

Test count: 472 → 480 (56 → 57 files).

Verified: `tsc --noEmit` clean, all 480 server tests passing. No Docker rebuild — test-only change.

## Round 245 — more test coverage (SOCKS5/TLS dispatcher settings)
No behavior changes. Continues the test-coverage push.

- `tests/socksProxy.test.ts` — `applySocksProxySetting`'s decision logic for undici's global fetch
  dispatcher: restoring the true default when the proxy URL is cleared, installing a cert-
  validation-disabled agent when TLS validation is off, rejecting an unparseable URL or one with
  the wrong protocol without touching the dispatcher or throwing, installing a real agent for a
  valid `socks5://` (and bare `socks://`) URL, and the settings-signature memoization that skips
  reinstalling the dispatcher on a repeated call with unchanged settings while still reinstalling
  when the URL actually changes. Deliberately scoped to this synchronous decision layer rather than
  the SOCKS5 handshake itself (delegated to the well-established `socks` and `tls` packages).

Caught a real design flaw in the test's own first draft before running it: `applySocksProxySetting`
memoizes on a signature string held in module-private state that isn't reset between tests, so
reusing the same proxy URL (or relying on comparing against a single captured "default" dispatcher)
across multiple tests meant a later test's call could silently no-op — or a leftover dispatcher
from an earlier test could be mistaken for the untouched case — depending on execution order. Fixed
by generating a guaranteed-unique proxy URL per call and, for the one test that needed to prove
"clearing the URL restores the true default," doing the install-then-clear sequence within a single
test so each step's signature is guaranteed fresh relative to its own immediately preceding call.

Test count: 464 → 472 (55 → 56 files).

Verified: `tsc --noEmit` clean, all 472 server tests passing. No Docker rebuild — test-only change.

## Round 244 — more test coverage (SMTP client)
No behavior changes. Continues the test-coverage push.

- `tests/smtp.test.ts` — `sendEmail`/`sendEmailWithAttachment` against a real local TCP server (a
  ~60-line hand-rolled fake SMTP server in the test itself, not a mocked socket) rather than mocking
  `net`/`tls`: the full EHLO/MAIL/RCPT/DATA/QUIT handshake, AUTH LOGIN sent with base64-encoded
  credentials when configured and skipped entirely when not, dot-stuffing a body line that would
  otherwise terminate the DATA block early (verified by confirming content *after* the escaped line
  still arrives in the same captured payload, which would be impossible if the escaping were
  broken), a rejected command surfacing as a real thrown "SMTP error", and the attachment path's
  multipart MIME structure and base64-encoded content. No `vi.mock` at all — since this client
  doesn't validate reply text, only the numeric status code, a real server that replies "250 OK" to
  anything outside a DATA block is enough to drive the whole implementation genuinely end to end.

Test count: 458 → 464 (54 → 55 files).

Verified: `tsc --noEmit` clean, all 464 server tests passing. No Docker rebuild — test-only change.

## Round 243 — more test coverage (web push notifications)
No behavior changes. Continues the test-coverage push.

- `tests/push.test.ts` — this session's first `vi.mock()` of an entire npm package (`web-push`,
  which talks to browser push services directly rather than through the global `fetch`
  `vi.stubGlobal` already covers). `ensureVapidKeys` generating and persisting keys once, then
  reusing them rather than regenerating. `saveSubscription`'s upsert-by-endpoint and
  `removeSubscription`. `sendPush` targeting every global subscription when no user is given versus
  only one user's own subscriptions, and its expired-subscription cleanup: a 404/410 send failure
  removes that subscription, any other failure logs and keeps it.

Caught two related test-authoring bugs before they ever ran, both from `Promise.all`-driven
concurrent sends: `mockRejectedValueOnce` rejects whichever call happens to land first, not
necessarily the target endpoint's — irrelevant when there's exactly one target, but wrong once
`sendPush` fans out across several. Fixed by keying the mock's rejection off the endpoint argument
itself instead of call order, and by asserting per-endpoint outcomes rather than an exact call
count in the "sends to every global subscription" test, since this suite's shared-DB-per-file
convention means earlier tests' subscriptions are still present when a later test's `sendPush` fans
out to "every global target."

Test count: 449 → 458 (53 → 54 files).

Verified: `tsc --noEmit` clean, all 458 server tests passing. No Docker rebuild — test-only change.

## Round 242 — more test coverage (update check, TheXEM scene numbering)
No behavior changes. Continues the test-coverage push — the first round tackling the harder,
network-mocked services after clearing the low-risk backlog.

- `tests/updateCheck.test.ts` — `checkForUpdate`'s round-number comparison (parsed from both the
  local `CHANGELOG.md`, mocked via `vi.spyOn(fs, "readFileSync")`, and GitHub's raw copy, mocked
  via `vi.stubGlobal("fetch", ...)`): update-available only when remote is strictly ahead, an
  unreadable local file or unparseable remote content treated as "unknown" rather than thrown, a
  non-ok HTTP response and a network-level failure both propagating as real rejections, and that
  the title regex accepts both an em dash and a plain hyphen separator.
- `tests/sceneNumbering.test.ts` — `syncSceneNumbering`'s full error surface (item not found, no
  external ids, no TVDB id specifically, TheXEM HTTP failure, network failure) versus its "nothing
  to map" non-error case, applying a `scene`/`scene_2` mapping to the matching episode row, skipping
  an incomplete or non-matching entry without counting it, and `syncAllSceneNumbering`'s
  type-filtering (series/anime only, movies never even requested).

Caught one test-authoring bug before it ever ran: the first draft of the `syncAllSceneNumbering`
test assumed it would only see the show it just inserted, but that function re-scans every
series/anime row in the table — including ones earlier tests in the same file left behind — so a
mock that only handled two specific TVDB ids and an exact call-count assertion would have broken
the moment other tests ran first. Fixed by making the mock tolerate any TVDB id and asserting on
the specific (nonexistent) id a movie would have used instead of a fragile total call count.

Test count: 428 → 449 (51 → 53 files).

Verified: `tsc --noEmit` clean, all 449 server tests passing. No Docker rebuild — test-only change.

## Round 241 — more test coverage (scheduled/remote backup)
No behavior changes. Continues the test-coverage push.

- `tests/scheduledBackup.test.ts` — `looksLikeBackupBundle`'s zip-magic-number check,
  `backupFileExtension` for the SQLite dialect, and a real `writeBackupBundle`/`readBackupBundle`
  round trip against the live test database (no mocking — `better-sqlite3`'s own online backup
  API and a real `adm-zip` bundle). `runScheduledBackup`'s full orchestration: no-ops when disabled
  or unconfigured, writes a real bundle and records `lastScheduledBackupAt` when it runs, skips a
  second run before the configured interval elapses, and rotates out the oldest backups beyond
  `backupKeepCount` while keeping the newest ones.
- `tests/remoteBackup.test.ts` — `uploadBackupToRemote`'s three no-op gates (not enabled, enabled
  without a bucket, bucket without credentials), each proven by passing a nonexistent local file
  path — since the function returns before ever reading it, reaching those branches at all confirms
  the AWS SDK is never touched.

Test count: 414 → 428 (49 → 51 files).

Verified: `tsc --noEmit` clean, all 428 server tests passing. No Docker rebuild — test-only change.

## Round 240 — more test coverage (logging, HTTP range streaming)
No behavior changes. Continues the test-coverage push.

- `tests/logger.test.ts` — the ring-buffer log store nearly every other test file already depends
  on indirectly, finally with its own coverage: level tagging, `Error`-argument serialization
  (stack, not `[object Object]`), the `level`/`search`/`since` filters on `getRecentLogs` (search
  case-insensitive, `since` a strict `>=` on timestamp), newest-first ordering, the configurable
  `logLevel` threshold actually suppressing lower-level entries from persistence, and the daily
  log file plumbing — `listLogFiles` reflecting a real file on disk and `resolveLogFilePath`
  rejecting a path-traversal attempt outright.
- `tests/rangeStream.test.ts` — `streamFileWithRangeSupport` against a real file and a hand-built
  fake Express response (a `PassThrough` decorated with `writeHead`/`status`/`set`/`json`, since
  `pipeline` needs a real writable stream to pipe into): the no-Range 200 fallback, a plain byte
  range, an open-ended range, a suffix range, clamping an out-of-bounds end instead of erroring,
  416 for a syntactically invalid or out-of-bounds range, 404 for a missing file, and the
  extension-to-Content-Type table including its `application/octet-stream` fallback.

Caught two test-authoring bugs in this batch, both in the test doubles rather than the source: the
range-stream fake `res.set` only implemented Express's object-argument form, silently swallowing
the real two-argument `res.set("Content-Range", value)` call the source actually makes (fixed by
supporting both signatures, matching Express itself); and the logger test's file-listing check ran
synchronously right after logging, racing `fs.createWriteStream`'s asynchronous file-open — fixed
by awaiting a short tick first rather than relying on incidental timing from other startup logging.

Test count: 393 → 414 (47 → 49 files).

Verified: `tsc --noEmit` clean, all 414 server tests passing. No Docker rebuild — test-only change.

## Round 239 — more test coverage (corrupt media detection, audio tag writing)
No behavior changes. Continues the test-coverage push.

- `tests/corruptMediaCheck.test.ts` — `checkForCorruptMedia` across its full decision tree: a
  missing file is recycled and marked missing by default, but only queued to `corrupt_media_review`
  (leaving the item alone) when review mode is enabled — and re-checking never queues a second
  review row for the same item. A non-probeable type (an ebook) is never flagged just because
  ffprobe can't parse it, and a `multiFilePerChild` sub-item (artist albums) is skipped entirely.
  One test drives the genuine ffprobe-failure path end to end — this environment has no ffprobe
  binary, so a real, stable file legitimately fails both the probe and its one retry, the same
  environment-driven determinism `archiveExtract.test.ts` and `multiDiscAlbum.test.ts` already
  lean on — and runs in ~7s real time since `corruptReason`'s anti-false-positive retry deliberately
  sleeps rather than using a mockable timer. Also covers `recycleAndMarkMissing` clearing the right
  path column (`file_path`, not `path`) for an episode row.
- `tests/audioTagWriter.test.ts` — `writeAudioTags` against a real `node-id3` round-trip (write then
  read back), no mocking needed: title/artist/album/track/year land correctly on an mp3, a non-mp3
  file is left byte-for-byte untouched, a missing target file never throws, and omitted optional
  fields don't error.

Test count: 381 → 393 (45 → 47 files).

Verified: `tsc --noEmit` clean, all 393 server tests passing. No Docker rebuild — test-only change.

## Round 238 — more test coverage (archive extraction, media compatibility analysis)
No behavior changes. Continues the test-coverage push.

- `tests/archiveExtract.test.ts` — `unpackDownloadedArchives` against real `.zip` archives built
  with `adm-zip` (no mocking needed): extraction into a sibling directory, the `.aonarr-extracted`
  marker preventing a second pass from re-extracting (verified by tampering with the extracted
  output and confirming it survives a second run), recursive discovery in subdirectories, the
  walk's max-depth guard never finding an archive nested too deep, and that non-archive files are
  left alone. Also confirms the documented "never throws" contract for a `.rar` needing the
  `unrar` binary this environment doesn't have — the same kind of environment-driven determinism
  Round 228's `multiDiscAlbum.test.ts` already relies on for ffprobe.
- `tests/mediaAnalysis.test.ts` — `analyzeCompatibility`'s full rule set (codec/HDR-format/bit-depth/
  audio-codec/image-subtitle notes, including that SDR content gets no HDR note at all and that two
  identical uncommon-codec notes are deduplicated rather than repeated) and `getLibraryAnalysis`'s
  aggregation across media_items/episodes/sub_items: codec/resolution/language counts, per-item
  compatibility notes, type scoping, and that a missing, malformed-JSON, or pre-Round-60-shape
  media_info value is treated as "not yet analyzed" instead of throwing or polluting the summary.

Test count: 359 → 381 (43 → 45 files).

Verified: `tsc --noEmit` clean, all 381 server tests passing. No Docker rebuild — test-only change.

## Round 237 — more test coverage (deleted-file detection, import review queue, settings store)
No behavior changes. Continues the test-coverage push.

- `tests/deletedFileCheck.test.ts` — `checkForDeletedFiles` across movies, episodes, and sub-items:
  clearing `has_file`/path fields when a file has vanished from disk, leaving present files alone,
  the opt-in `unmonitorDeletedFiles` setting also clearing `monitored`, and the episodic/collection
  parent-rollup (a series' own `has_file` flips back to 0 once its last file-bearing episode is
  gone, but stays 1 while any sibling episode still has one).
- `tests/importReview.test.ts` — `queueForReview`'s dedup check against *any* existing row for the
  same (source, list, type, title, year) regardless of its status — including the `IS NOT DISTINCT
  FROM` null-safe comparison for a `null` list id or `null` year matching another `null` rather than
  failing the equality check the way plain `=` would.
- `tests/settingsStore.test.ts` — this suite's first dedicated coverage of the setting cache that
  nearly every other test file already depends on indirectly. Covers the synchronous cache read
  immediately reflecting a `setSetting()` call (the whole reason this store isn't a plain async DB
  wrapper), encryption-at-rest for sensitive-looking key names (case-insensitively, across every
  recognized suffix: password/apikey/token/secret/privatekey/userkey/webhookurl) while the cache
  keeps serving plaintext, overwrite-not-duplicate semantics, and `deleteSetting` clearing both the
  cache and the underlying row.

Caught one test-authoring bug in this batch: the first draft of `importReview.test.ts`'s
different-import-list-ids test used bare `importListId: 1`/`2`, tripping the real
`import_list_id` foreign key (no such `import_lists` rows existed). Fixed by inserting two real
`import_lists` rows first and using their actual generated ids.

Test count: 336 → 359 (40 → 43 files).

Verified: `tsc --noEmit` clean, all 359 server tests passing. No Docker rebuild — test-only change.

## Round 236 — more test coverage (env var resolution, admin bootstrap, friend library comparison)
No behavior changes. Continues the test-coverage push.

- `tests/env.test.ts` — `readEnvOrFile`'s Docker-secrets `_FILE` precedence over the plain env var,
  trimming file contents, and failing closed (returning `undefined`, not falling back to the plain
  var) when a configured `_FILE` path can't be read.
- `tests/bootstrapAdmin.test.ts` — `bootstrapAdminFromEnv`'s "only ever acts once" gate (a no-op
  once any admin exists, whatever the env vars say), the minimum-password-length refusal, username
  trimming, that the stored value is a hash and not the plaintext password, and the `_FILE` variant
  for both username and password.
- `tests/friendLibraries.test.ts` — `compareFriendLibrary` across all three friend-server shapes
  (Plex's section-based API, Jellyfin's and Emby's shared Items API differing only by the `/emby`
  path prefix), fetch-mocked by URL like Round 235's `trashSync.test.ts`. Covers title/year matching
  (case- and punctuation-insensitive, ±1 year tolerance, a `null` year on either side always
  matching), deduplication of repeated friend titles, alphabetical sorting of the result, a single
  failed Plex section not losing the others, and that a friend with zero users is never queried for
  items at all.

Caught one test-authoring bug in this batch: `bootstrapAdminFromEnv` only ever acts when *no* admin
exists yet in the whole database, but `server/tests/` gives every test in a file the same DB — so
the first test to successfully create an admin was silently making every later test in the same
file a no-op. Fixed by wiping the `users` table in an `afterEach`, giving each test in
`bootstrapAdmin.test.ts` a truly clean slate rather than relying on execution order.

Test count: 312 → 336 (37 → 40 files).

Verified: `tsc --noEmit` clean, all 336 server tests passing. No Docker rebuild — test-only change.

## Round 235 — more test coverage (cleanup suggestions, TRaSH-Guides format translation/sync)
No behavior changes. Continues the test-coverage push.

- `tests/cleanupSuggestions.test.ts` — `findUnmonitoredNoFile`'s monitored/has_file filtering, and
  `findDuplicateFiles`' byte-identical-content detection (same size *and* matching partial hash,
  not just same size) across movies, episodes, and sub-items (albums), including that a missing
  file on disk is skipped rather than throwing and that episode/sub-item labels are built from
  their parent title correctly.
- `tests/trashFormats.test.ts` — `translateTrashFormat`'s mapping of each portable TRaSH-Guides
  specification (title, release group, size with its GB→MB conversion, and resolution's known-value
  table), and that anything else — an internal-only implementation, an unmapped resolution value, or
  a spec with the wrong value type — is reported back as skipped rather than silently dropped or
  guessed at.
- `tests/trashSync.test.ts` — this session's first network-mocked test file (`vi.stubGlobal` on
  `fetch`, keyed by URL). Covers `syncTrashFormats`' add-vs-update branch (matched by `trash_id`),
  per-app library-type scoping (radarr → movie/ppv, sonarr → series/anime/sports), unsupported-format
  reporting, and three independent failure paths that must never abort the rest of a sync: a failed
  directory listing, a single file's download failing or throwing, and a name collision with an
  existing manually-created format (`custom_formats.name` is UNIQUE).

Caught one test-authoring bug in this batch: the first draft of the episode-duplicate test in
`cleanupSuggestions.test.ts` inserted two episode rows at the same (show, season, episode) to give
them identical file content, which collided with the real `UNIQUE(media_item_id, season_number,
episode_number)` constraint. Fixed by using two different episode numbers — the realistic shape
for a content-level duplicate anyway, since two rows can never share one episode slot.

Test count: 284 → 312 (34 → 37 files).

Verified: `tsc --noEmit` clean, all 312 server tests passing. No Docker rebuild — test-only change.

## Round 234 — more test coverage (storage forecast, root folder auto-select/quota, release group stats)
No behavior changes. Continues the test-coverage push.

- `tests/storageForecast.test.ts` — `recordDiskUsageSamples`' once-per-calendar-day dedup and its
  skip-unreachable-folders-without-throwing behavior, and `getStorageForecast`'s straight-line
  days-until-full projection: needs 2+ samples spanning a trustworthy time window, only ever uses
  the oldest and newest sample (ignoring any in between), and reports no forecast (rather than a
  negative or infinite one) when free space is growing instead of shrinking.
- `tests/rootFolderSelect.test.ts` — `autoSelectRootFolderId`'s most-free-space selection when a
  media type has multiple root folders (`fs.statfsSync` mocked via `vi.spyOn` for deterministic
  free-space values, since real temp dirs in the test environment share one filesystem), skipping
  straight to the only folder without touching the filesystem at all when there's just one, and
  treating an unreachable path as least-preferred rather than throwing. `isRootFolderOverQuota`'s
  live statfs-based percentage check, its quota-not-configured and quota-disabled null-guards, and
  that an unreachable path is never reported as over quota.
- `tests/releaseGroupStats.test.ts` — `recordGroupSuccess`/`recordGroupFailure`'s UPSERT counters
  staying independent per group and per outcome type, `getGroupReputation`'s neutral 0.5 default
  for unknown groups and groups with fewer than 3 recorded outcomes (so one lucky/unlucky grab
  can't swing ranking), and `listReleaseGroupStats`' sort by total activity.

Test count: 257 → 284 (31 → 34 files).

Verified: `tsc --noEmit` clean, all 284 server tests passing. No Docker rebuild — test-only change.

## Round 233 — more test coverage (metadata export, HTTP metrics, indexer health, recycle bin)
No behavior changes. Continues the test-coverage push.

- `tests/metadataExport.test.ts` — the .nfo/.opf/.plexmatch/.json export builders (root element by
  shape, XML-escaping, omitting absent optional fields rather than emitting empty tags),
  `safeFileName`, and `writeNfoSidecar`'s "never throw" contract.
- `tests/httpMetrics.test.ts` — per-route request/error/latency aggregation, and that only 5xx
  responses count as errors.
- `tests/indexerHealth.test.ts` — success-rate/average-response-time computation, last-check
  outcome reporting, the 50-row-per-indexer cap, and that each indexer's history stays independent.
- `tests/recycleBin.test.ts` — the most load-bearing new file this round: real file and directory
  moves (a Music album is a directory, not a file) through recycle/restore/purge, *and* the
  cross-filesystem (EXDEV) fallback path specifically, forced via `vi.spyOn` on `fsp.rename` since
  the test environment's own temp dirs share one real filesystem and would never otherwise exercise
  it. This is the regression test the Round 227/228 "recycle bin couldn't handle directories" fix
  never had — confirms moving, restoring, and purging a directory all work, in both the same-
  filesystem and cross-filesystem cases.

Test count: 226 → 257 (27 → 31 files).

Verified: `tsc --noEmit` clean, all 257 server tests passing. No Docker rebuild — test-only change.

## Round 232 — more test coverage (media query building, blocklist, audit log, upgrade candidates)
No behavior changes. Continues the test-coverage push.

- `tests/mediaQuery.test.ts` — `buildMediaQuery`, the shared WHERE-clause builder behind both
  `GET /api/media` and its stats endpoint: the security-critical empty-`allowedTypes` short-circuit
  (`where: null` so the caller never runs a query that could leak rows), content-rating exclusion
  list construction, tag/group/status filter branches, and `toFts5Query`/`clampLimit`/`clampOffset`.
- `tests/blocklist.test.ts` — exact (non-fuzzy) release-title matching, scoped per media item.
- `tests/audit.test.ts` — `logAuditEvent`'s fire-and-forget write and `auditActor`'s session-user
  vs. bare-API-key attribution.
- `tests/upgradeCandidates.test.ts` — `findUpgradeCandidates` across all three shapes (movie,
  episode, sub-item), including that an item with no quality profile assigned is skipped rather
  than throwing.

Test count: 197 → 226 (23 → 27 files).

Verified: `tsc --noEmit` clean, all 226 server tests passing. No Docker rebuild — test-only change.

## Round 231 — more test coverage (rate limiting, request tracing, child counts, exclusions, types)
No behavior changes. Continues Round 229/230's test-coverage push.

- `tests/rateLimiter.test.ts` — the in-memory login/API-key brute-force limiter: allows under the
  failure threshold, locks out at it with a `retryAfterSeconds`, `recordSuccess` actually resets the
  failure count (not just lifts a lockout), a lockout expires on its own after the window, an
  unlocked bucket's failures don't carry into a new window once stale, and separate keys stay
  independent.
- `tests/requestContext.test.ts` — the `AsyncLocalStorage`-based request-id propagation every log
  line gets tagged with: survives an `await`, doesn't leak between two concurrent requests, and
  doesn't leak past the end of the request that set it.
- `tests/childCounts.test.ts` — `attachChildCounts`' per-shape branching (episodic uses `episodes`,
  collection uses `sub_items`, single-shape is left untouched) and that an episodic/collection item
  with zero children yet gets no count attached at all rather than `{0, 0}`.
- `tests/importExclusions.test.ts` — `isExcluded`'s external-id-first-then-title-fallback matching,
  including that an external id match requires the *provider* to agree too, and that the title
  fallback is scoped to both media type and (when both sides have one) year.
- `tests/mediaTypes.test.ts` — `getMediaTypeConfig`/`isValidMediaType`/`isProbeableFile`, and that
  `multiFilePerChild` is set on exactly the two types where a child's download is normally many
  files (Music albums, Audiobook chapters) — written expecting it to be Music-only, corrected once
  the test itself revealed Audiobooks also carries the flag.

Test count: 166 → 197 (18 → 23 files).

Verified: `tsc --noEmit` clean, all 197 server tests passing. No Docker rebuild — test-only change.

## Round 230 — a Round 227 fix that was never actually applied, caught by its own regression test
While continuing to expand test coverage (more of Round 229's work), writing a regression test for
Round 227's "custom format size condition ignores negate when size is unknown" fix immediately
failed — the fix described in that changelog entry and commit message was never actually made to
`services/customFormatScoring.ts`; `groupPasses`'s "size" branch still hardcoded `return false` for
an unknown size regardless of `negate`, unlike every sibling condition type. Applied the real fix
now (`return group.negate ? true : false`, matching indexerFlag/releaseGroup/source/resolution/year)
and confirmed live: a custom format with a negated size condition and no known size now correctly
appears in a Test Parsing match instead of being silently excluded.

This was specifically the kind of gap live-testing didn't catch in Round 227 — internal scoring
logic like this was verified by reading the diff, not by exercising it end-to-end the way the
security fixes were (a restricted test user, real HTTP calls). It's also why the two other findings
this round add tests for below were worth writing tests for even without a live repro: a test either
confirms the fix or, as it just did here, catches that it was never real.

Also added two more test files as part of the same test-coverage push:
- `tests/nfoParser.test.ts` — Kodi/Jellyfin-style .nfo sidecar parsing (movie/tvshow/episodedetails
  root elements, poster-tagged thumb selection, uniqueid vs. legacy imdbid fallback, year derived
  from `<premiered>` when `<year>` is absent, and an unrecognized root element returning an empty
  result instead of throwing).
- `tests/duplicates.test.ts` — `findRepeatedImports`' history-based repeat-detection (grouping by
  item+episode+sub-item, per-episode labeling, sort order, and tolerating a malformed history row).
- A regression test for the real fix above, added to `tests/customFormatScoring.test.ts`.

Test count: 152 → 166 (16 → 18 files).

Verified: `tsc --noEmit` clean, all 166 server tests passing, and a live check against the rebuilt
local Docker stack (created a custom format with a negated, size-unknown condition and confirmed it
now matches). Docker images rebuilt and pushed this round — unlike Round 229, this one does change
real runtime behavior.

## Round 229 — expand automated test coverage (security-critical + previously-untested logic)
No behavior changes — this round adds regression tests for code that had none, prioritizing (a)
security-critical pure logic and (b) real bugs fixed in Rounds 225/227 that had no automated
regression coverage guarding them, so a future edit that reintroduces one of them fails a test
instead of waiting for a third audit to catch it. Two helper functions were exported (no logic
changes) specifically so their tests could call them directly rather than only exercising them
indirectly through a much heavier end-to-end path: `isEventEnabledFor` (`services/notifications.ts`)
and `effectiveRetentionDays` (`services/archival.ts`).

- `tests/encryption.test.ts` — the AES-256-GCM encrypt/decrypt round trip now protecting three more
  credential tables as of Round 227, including that a legacy plaintext value passes through
  unchanged, and that a key mismatch (the documented "backup restored into a different config
  volume" failure mode) throws loudly rather than returning silently-wrong plaintext.
- `tests/totp.test.ts` — per-user TOTP: input validation, accepting a real code within the ±1 step
  clock-drift window, and rejecting one from further away or generated for a different secret.
- `tests/auth.test.ts` — password hashing, one-time pending-login tokens, session creation/
  expiry/destruction, and a regression test for Round 225's `listActiveSessions` fix (comparing an
  ISO `expires_at` against "now" as raw text made any same-day-expiring session look still-active,
  since `'T'` sorts above `' '` at the character position the two formats otherwise agree on).
- `tests/contentRatings.test.ts` — the `isRatingBlocked`/`CONTENT_RATING_ORDER` logic gating most of
  Round 227's access-control fixes, previously exercised only indirectly through route-level tests.
- `tests/mediaServerImport.test.ts` — `titlesMatch`, `externalIdsOverlap`, `titleAndYearMatch`'s
  year-gating branches, and a regression test for Round 227's `exactTitlesMatch` fix (Starr/Lidarr/
  Readarr artist-author matching must not fold "Extraction" into "Extraction 2" the way the
  substring-tolerant `titlesMatch` would).
- `tests/notifications.test.ts` — a regression test for Round 227's `isEventEnabledFor` fix (a
  provider's events setting being unset vs. explicitly saved empty must not read the same way, or
  unchecking the last event silently re-enables all of them).
- `tests/archival.test.ts` — `pathTail`'s cross-mount-point/case-insensitive matching, and
  `effectiveRetentionDays`'s override resolution (tag vs. collection, `-1`/never-archive beating any
  duration, the longest duration winning among several, an override-less tag/collection being
  ignored).

Test count: 93 → 152 (9 → 16 files). Docker images were not rebuilt for this round — nothing in the
compiled server's actual behavior changed (the two newly-exported functions are unchanged aside
from visibility), so a multi-arch rebuild/push would ship an identical runtime for no benefit.

Verified: `tsc --noEmit` clean, all 152 server tests passing (including catching and fixing one bug
in the tests themselves — an incorrect column name in a new `auth.test.ts` assertion — before this
was committed).

## Round 228 — close out Round 227's deferred multi-disc findings + remaining error-handling gaps
Two items were deliberately left open at the end of Round 227 as "medium confidence/severity,
needs a clear head rather than audit-time-pressure to fix safely" — closed out properly this round,
plus a second related bug found while re-examining the first, and the last few pages from Round
227's "add missing error handling" sweep that hadn't been reached yet.

**Multi-disc album handling**
- Scan & Import's Music branch identified a multi-disc album's folder correctly (e.g.
  "Artist/Album [2CD]/CD1/track.mp3" already correctly guessed "Album [2CD]" as the title,
  regardless of the CD1/CD2 subfolder), but `sub_items.file_path` was set to whichever specific
  disc subfolder was scanned *first* — a second disc's tracks got recorded, but the album's own
  file-path pointed at only one disc's folder, which anything treating that column as "the album's
  whole location" (`deletedFileCheck.ts`, `cleanupSuggestions.ts`) would misread. Now points at the
  shared album folder instead of the first-scanned disc (`services/libraryScan.ts`).
- The download-import path (`placeAlbumFiles`) only ever listed files directly inside the anchor
  file's own folder — for a multi-disc download laid out as disc subfolders, only the anchor's own
  disc ever got moved/imported; every other disc's tracks were silently left behind in the downloads
  folder forever, uncleaned-up and unimported. Now detects a disc-subfolder layout (folder name like
  "CD1"/"Disc 2") and collects every disc's files (one level of subfolders, not arbitrary
  recursion, so an unrelated nested folder like artwork doesn't get swept in) — and, when naming is
  disabled, keeps the destination folder named after the album rather than "CD1"
  (`services/importer.ts`).
- Found while fixing the above: a disc's own filenames typically restart at "01", but a multi-disc
  album's `tracks.track_number` is one continuous sequence across the whole album (disc 2 picks up
  after disc 1's count) — matching a file to a track by its literal leading number alone, with no
  disc awareness, let disc 2's "01" silently overwrite disc 1's real track 1's `has_file`/`file_path`
  and leave disc 2's own track permanently unmatched. Fixed in both places this matching happens:
  `placeAlbumFiles` now offsets each disc's own leading numbers by the track count of every earlier
  disc (`services/importer.ts`), and the Scan & Import / `backfillMissingAlbumTracks` shared
  `upsertTrackFromFile` helper now detects when a computed track number is already claimed by a
  *different* file and falls back to appending a new one instead of overwriting
  (`services/libraryScan.ts`) — both degrade safely to "no confident match" (original behavior)
  rather than a wrong match if the heuristic doesn't apply cleanly.
- Added `tests/multiDiscAlbum.test.ts`, covering both the download-import path and the
  already-organized-on-disk scan path against a real 2-disc fixture on a real filesystem — asserts
  every track lands on its correct, distinct `track_number` and `sub_items.file_path` ends up at the
  shared album folder in both cases.

**Frontend — remaining error-handling gaps from Round 227's sweep**
- `IptvPlaylists.tsx`: all ten mutating actions (add/edit/delete playlist, regenerate token, add/
  move/remove item, attach/detach filler, add/edit/delete filler clip) now surface a failure instead
  of leaving the modal in an inconsistent state with no feedback.
- `Account.tsx`: starting 2FA setup now surfaces a failure (relevant now that re-keying an
  already-enabled account correctly requires the current code, per Round 227 — see that entry).
- `AuditLog.tsx`: a failed page load now shows an error instead of either a permanently blank page
  (on the very first load) or silently continuing to show the previous page's rows with no
  indication the requested page never actually loaded.
- `NamingSetupModal.tsx`: a failed save now shows an error instead of failing as an unhandled
  promise rejection with no visible feedback.

Verified: `tsc --noEmit` clean on both packages, 93/93 server tests passing (91 from Round 227 + 2
new multi-disc regression tests), and a live rebuild of the local Docker stack confirming a clean
boot and normal page behavior.

## Round 227 — second full-codebase bug audit: ~50 fixes across security, data integrity, and the UI
Seven parallel exhaustive read-throughs (media-pipeline services, downloads/search/quality
services, integrations/infra services, routes A + the DB layer, routes B, and two web-frontend
halves), each finding independently verified against source — and for the security-relevant ones,
against a live restricted-account/token test on the rebuilt local Docker stack — before being
touched. This is a second pass on top of Round 225/226, so most of what's left here is subtler:
cross-file inconsistencies, race conditions, and edge cases the first pass's broader sweep missed.

**Security / access control**
- Six per-item routes (`/:id/cast`, `/alternate-titles`, `/ratings`, `/collection`, `/trailer`,
  `/history`) checked library-type access but not content rating, unlike `GET /:id` itself — a
  restricted user's blocked R-rated movie still leaked its cast, trailer, ratings, and grab history
  through these siblings. Now gated identically (`routes/media.ts`).
- The series/narrator sibling widget on the sub-item detail page (audiobook/book series, shared
  audiobook narrators) had no type/rating filter at all, leaking a sibling's title/poster/hasFile
  across a library boundary the requesting user couldn't otherwise see (`routes/media.ts`).
- Approving a request never checked whether the title was already in the library — a household
  member's request for something an admin had already added directly silently created a second,
  independently-monitored duplicate. Now checks (and 409s with the match, same as `POST /media`,
  overridable with `confirmDuplicate`); auto-approve leaves the request pending instead of guessing
  (`routes/requests.ts`).
- Per-user TOTP `/setup` (when 2FA is already enabled) and `/disable` only required a valid session
  token — a hijacked token alone (XSS, a leaked/shared session) could silently re-key or strip 2FA
  from an account, defeating the entire point of a second factor surviving a token compromise. Both
  now require the current TOTP code, matching what the client already collects and sends
  (`routes/authRoutes.ts`).
- `GET /api/library-views` had no library-type scoping — a restricted user could enumerate saved
  view names/filters for a library type they have no access to (`routes/libraryViews.ts`).
- OPDS's `GET /item/:id` and both download endpoints never checked the item's own type against the
  four documented OPDS-eligible types — the shared OPDS token doubled as a raw file server for
  Music/Video/Podcast/Course (and any other type), not just books/comics/audiobooks
  (`routes/opds.ts`).
- IPTV's `/stream/:kind/:id` served any single/episodic library item by raw id with no check that it
  was actually attached to an enabled playlist — the shared playlist token could stream anything in
  the library, including an `adult`-type item never added to any playlist (`routes/iptv.ts`).
- Dashboard `/library-counts` and `/library-sizes` filtered by library type but not content rating,
  unlike every other route in the file — a restricted user's per-type counts/disk-usage included
  rating-blocked items they can't actually browse (`routes/dashboard.ts`).
- `GET /api/settings/` returned the live per-instance TOTP secret/pending-secret in plaintext to any
  admin session — unlike every other credential type here, this one exists specifically to survive
  a compromise of that same admin session, so exposing it defeated the point. Now excluded from the
  generic settings dump (`routes/settings.ts`).
- The actor/person credits page cross-referenced the library with no type/rating filter, revealing
  "in your library" for a title a restricted user isn't allowed to see (`routes/people.ts`).
- A user's library-access grant (`POST`/`PATCH /users`) deleted and re-inserted access rows outside
  a transaction — a DB error mid-loop could leave a user's access deleted but only partially
  restored. Now wrapped in `db.transaction()` (`routes/users.ts`).
- Encryption-at-rest (AES-256-GCM, same mechanism as the `settings` table) extended to
  `download_clients.password`/`.api_key`, `irc_feeds.sasl_pass`, and `ai_providers.api_key` — these
  live in their own tables rather than `settings`, so they were never covered by the existing
  encryption despite carrying real credentials. A startup migration re-encrypts any legacy plaintext
  rows automatically, same self-healing pattern as the settings-table fix
  (`app.ts`, `db/mappers.ts`, `routes/downloadClients.ts`, `routes/aiProviders.ts`,
  `routes/ircFeeds.ts`, `services/ircFeedManager.ts`, `services/aiIdentify.ts`) — verified live: a
  plaintext credential inserted directly into the DB was automatically re-encrypted on the next
  boot, and the API still round-trips the correct decrypted value back to the admin.

**Data integrity / silent misbehavior**
- Scan & Import's episodic and single-file-per-child branches looked up an existing episode/item by
  id only and unconditionally overwrote its `has_file`/`file_path` — unlike the sibling "single"
  shape branch, which already skips rather than clobbers. A stray duplicate or sample file that
  merely parsed to the same season/episode silently repointed AoNarr's record at the wrong file,
  orphaning the real one. Now skips and logs, matching the "single" shape's existing behavior
  (`services/libraryScan.ts`).
- Migrating a Lidarr/Readarr library (artist/author matching) used a substring-tolerant title match
  with no year to gate it — the exact class of bug `libraryScan.ts`'s own `titlesMatch` was made
  exact-only to fix, reintroduced here for Music/Books imports. Added an exact-match variant and
  switched Starr's artist/author resolution to it (`services/mediaServerImport.ts`,
  `services/starrImport.ts`).
- Cross-filesystem archive moves (`/config` vs `/media` in Docker) fell back to a fully synchronous
  copy, blocking the entire event loop — every user's request stalls for as long as a multi-GB
  archive move takes. `recycleBin.ts` was already fixed for this exact issue; `archival.ts` wasn't.
  Now uses the same async `fsp.cp`/`fsp.rm` pattern (`services/archival.ts`).
- The recycle bin's move/purge/restore path used `copyFile`/`unlink`, which throw on a directory —
  Music's `sub_items.file_path` is a directory, so recycling/deleting/restoring an album silently
  failed (swallowed as "already gone") and orphaned it on disk untracked. Now uses `fsp.cp`/`fsp.rm`
  with `recursive: true`, which handles both files and directories (`services/recycleBin.ts`).
- The media-server mismatch check (Settings → System health) only ever queried `movie`/`series`,
  silently reporting zero mismatches for anime/sports/ppv/adult libraries regardless of actual state
  — now covers every single/episodic-shape type (`services/libraryValidation.ts`).
- `media_items.size_bytes`, `queue.size`, and `recycle_bin.size_bytes` were never `Number()`-wrapped
  like every other aggregate in this codebase — under the Postgres driver, node-pg returns a BIGINT
  column as a JS string, silently turning size arithmetic into string concatenation
  (`db/mappers.ts`, `routes/recycleBin.ts`).
- Season/episode zero-padding in Wanted/Calendar labels broke for a season or episode numbered 100+
  (some long-running anime number this way), rendering e.g. "E100" as "E00" (`routes/wanted.ts`).
- The hand-rolled SMTP client had no socket timeout at all — a mail host that accepts the TCP
  connection but never replies hung `sendEmail()` forever, and since `scheduler.ts`'s `grab()`
  awaits the notification synchronously, one unreachable SMTP host wedged the entire grab pipeline,
  not just email. Added a 30s idle timeout (`services/smtp.ts`). The IRC client had the same gap for
  a connection that goes silent without ever closing — added a 10-minute idle timeout, well past any
  compliant ircd's own keepalive interval (`services/ircClient.ts`).
- "Because you watched X" auto-request could recommend the same tmdb id twice in one batch (two
  source items both recommending it, or it appearing under both the "added" and "watched" bases,
  each computed with its own unrelated dedup set) and inserted it as two separate library rows with
  no existence check. Now re-checked against the live library and against ids already inserted
  earlier in the same run (`services/recommendations.ts`).
- The watch-status sync cursor advanced past every watched file's timestamp regardless of whether it
  matched anything in the library — a title watched before AoNarr imported/matched it permanently
  lost its watch event once the cursor moved past that timestamp. Now only advances past a file once
  it's actually matched and recorded (`services/mediaServerWebhook.ts`).
- TorBox and AllDebrid download-client adapters polled a stuck/dead torrent forever — the shared
  `DEBRID_POLL_TIMEOUT_MS` deadline was only enforced in RealDebrid's own poll loop. Both now enforce
  it too (`services/downloadClient.ts`).
- A custom format's "size" condition returned a hardcoded `false` when size was unknown, ignoring
  `negate` — every other condition type correctly inverts under `negate`, per the function's own
  documented contract. Reachable from IRC auto-grab (which never knows size upfront) and the Custom
  Format tester (`services/customFormatScoring.ts`).
- Merging an audiobook's tracks into one M4B didn't clean up the partial output file if ffmpeg
  failed or hit its 30-minute timeout, leaving an orphaned (possibly corrupt) file in the library
  folder (`services/audiobookConvert.ts`).
- The SOCKS5 proxy's TLS connector left a stale `error` listener attached after a successful
  handshake — an unrelated later socket reset (e.g. an idle keep-alive connection dropped by the
  proxy) could re-invoke the undici connector callback a second time, undefined behavior for a
  contract that requires exactly one call (`services/socksProxy.ts`).
- The pre-restore SQLite safety snapshot never checkpointed the WAL before copying the file — in WAL
  mode, recently-committed transactions can live only in `-wal` until the next automatic checkpoint,
  so the snapshot taken just before a restore could miss them (`routes/system.ts`).
- `duplicateCheck.ts`'s `mergeMediaItems` doc comment inaccurately described a colliding child's
  fate — its file is left alone, but its own DB row is still lost via `ON DELETE CASCADE` once the
  loser is deleted, even when `deleteFiles` is false. Comment corrected to describe actual behavior.

**Frontend**
- `MediaDetail.tsx`'s inline edit-metadata/artwork/move/split panels (unlike Manual Import and
  Search Results, these render inline rather than in a blocking Modal) didn't reset when navigating
  to a different item via a collection/sibling link — editing Movie A's metadata, then clicking a
  sibling to Movie B without closing the panel, silently saved A's stale fields onto B on submit.
  `load()` and `runSearch()` also had no stale-response guard, so a slow response for a previous
  item could land after a newer one and show/grab against the wrong item. All now reset on item
  change and guard against stale responses. `SubItemDetail.tsx` and `EpisodeDetail.tsx` had the same
  gaps for their own search-results (and, for episodes, the manual-import browse) panels — fixed the
  same way.
- `LibraryType.tsx`: the poster grid's Unreleased/Missing banner parsed a date-only release date as
  UTC midnight, shifting the boundary by the viewer's UTC offset (the same class of bug already
  fixed in Calendar.tsx/Dashboard.tsx) — now compares local calendar days. The content-rating filter
  wasn't reset when switching library type, so a filter like "R" carried over and silently emptied a
  library with no matching ratings. The scroll-restore-on-Back guard was a single boolean that
  latched permanently true on its first use, silently disabling scroll restoration for every other
  library type visited afterward in the same session — now tracked per URL.
- Unchecking the last enabled event for a notification provider snapped every checkbox straight back
  to checked — both the frontend's read side and the server's `isEventEnabledFor` treated "no
  preference, saved as empty string" and "explicitly zero events" as the same falsy value. Fixed on
  both sides so an explicitly-empty selection actually means "send nothing," not "send everything"
  (`components/SettingsProviderTiles.tsx`, `services/notifications.ts`).
- AI Providers' "Test connection" always tested the persisted row, never the form's current values —
  editing a wrong Base URL and testing before saving silently verified the old value. Now saves the
  form first (`pages/AiProviders.tsx`).
- Remote Library: switching the selected instance reset the type filter (Round 226) but not the
  stale item grid/error from the previous instance, which stayed on screen with no indication it was
  stale (`pages/RemoteLibrary.tsx`).
- Opening Manual Import for two different queue items in quick succession could show/import the
  wrong file if the first request resolved after the second (`pages/Activity.tsx`).
- Dashboard's six parallel widget requests had no `.catch()` — one failure rendered every widget as
  legitimately empty with no indication anything failed. Now surfaces a visible error banner
  (`pages/Dashboard.tsx`).
- Media Analyzer didn't clear stale data or surface an error on a failed reload after switching
  library type, silently showing the previous type's stats/file list (`pages/MediaAnalyzer.tsx`).
- Watchlist Import's single-title form was cleared even when the import failed, forcing a retype to
  retry (`pages/WatchlistImport.tsx`).
- Download Clients' Delete closed the modal unconditionally regardless of whether the delete
  actually succeeded, and Add/Edit had no error handling at all (`pages/DownloadClients.tsx`).
- System's "Delete all unmonitored" bulk action had no error handling or busy guard — one failure
  mid-loop left already-deleted items still listed with no indication, and re-clicking re-attempted
  deletes on rows already gone. Now removes items as each delete actually succeeds, disables the
  button while running, and reports any failures (`pages/System.tsx`).
- Reordering collection items optimistically updated the UI with no rollback on failure, silently
  diverging from the server until a full reload (`pages/CollectionDetail.tsx`).
- Switching Add Media's Type dropdown to one that supports metadata search didn't exit manual-entry
  mode if a previous no-search type had forced it on (`pages/AddMedia.tsx`).
- Global Search had no guard against overlapping searches — re-searching (e.g. via a "Recent" badge)
  while a slower metadata-provider fetch was still in flight could show a stale query's "Add new"
  results (`pages/GlobalSearch.tsx`). Settings' Format Scores tile had the same gap when rapidly
  switching the quality-profile dropdown (`pages/Settings.tsx`).
- Import Review's apply-match flow made two sequential POSTs with no error handling — if the import
  succeeded but marking it resolved failed, retrying the same match would create a duplicate library
  item with no warning (`pages/ImportReview.tsx`).
- Comparing friend libraries in quick succession had the same overlapping-request gap, letting a
  stale comparison overwrite a newer one (`pages/FriendLibraries.tsx`).
- Three retention/query-limit inputs (Settings tags, Collection detail, Indexers) used an
  uncontrolled input with no `key` tied to the underlying value, unlike the correct pattern already
  used in `ImportLists.tsx` — an externally-changed value (a second admin, an MCP call) kept
  showing the stale one until manually edited.
- The What's New page's minimal markdown renderer never handled inline `**bold**` or `` `code` ``
  spans, showing literal asterisks/backticks across nearly every bullet point in the real changelog
  content (`pages/Changelog.tsx`).
- The command palette (Ctrl/Cmd+K) had its own independent Escape handler, so opening it over an
  already-open Modal-based dialog and pressing Escape closed both at once. Now shares `Modal.tsx`'s
  own dialog stack so only the topmost overlay reacts (`components/CommandPalette.tsx`,
  `components/Modal.tsx`).
- The router had no catch-all route — a mistyped/bookmarked URL, or a household account following a
  link to an admin-only page (whose `<Route>` isn't even registered for them), rendered a blank
  content area with no redirect (`App.tsx`).
- Added missing error handling to several admin actions that previously failed silently with no
  feedback: Blocklist remove/clear-all, Duplicates monitor-toggle/dismiss, Jobs run-now/cancel, IRC
  Feeds remove, Collections create/delete, and Requests approve/reject/cancel (which also now
  handles the new duplicate-request 409 the same way the request-submission form already did).

Verified: `tsc --noEmit` clean on both packages, 91/91 server tests passing, plus a live
restricted-account/token pass on the rebuilt local Docker stack covering every access-control fix
above (all six per-item rating gates, dashboard counts/sizes, OPDS/IPTV token scoping in both
directions, TOTP setup/disable rejection, the settings TOTP-secret exclusion, the request
duplicate-check and its override, and the encryption-at-rest round-trip including the legacy-
plaintext migration).

## Round 226 — clean up Round 225's deferred low-priority findings
The five findings flagged LOW severity/confidence at the end of Round 225's audit and deliberately
left open — closed out:
- `comicImageConvert.ts`: two pages that only differed by original extension (e.g. `page01.png` and
  `page01.jpg`) both mapped to the same re-encoded name (`page01.webp`) — adm-zip's `addFile`
  silently overwrites on a name collision, so the second page vanished from the archive. Now
  disambiguates with a `-2`, `-3`, ... suffix on collision.
- `audiobookConvert.ts`: (1) the merged output path wasn't checked against the source track paths
  before running `ffmpeg -y`, which would truncate an input while reading it if the two ever
  collided (e.g. re-running the merge on an already-converted book) — now throws clearly instead.
  (2) Source track files were `unlinkSync`'d *inside* the `db.transaction` that swaps the per-track
  rows for the single merged row — a failed INSERT rolled the DB back but left the files already
  deleted, permanently losing the source audio with no matching DB row. Deletion now happens after
  the transaction commits successfully.
- `RemoteLibrary.tsx`: switching the selected remote instance didn't reset `typeFilter`, so a type
  filter picked for one instance silently carried over and filtered browsing of the next one.
- `LibraryType.tsx`'s `loadFieldSet` treated a saved *empty* column-set the same as "nothing saved
  yet" and fell back to the defaults — a user who deliberately cleared all extra fields couldn't
  make that choice stick across reloads.
- `IptvPlaylists.tsx`: creating a playlist calls `setMode(created.id)` to jump straight into edit
  mode, but the modal's render guard required `editingPlaylist` (looked up from the `playlists`
  array) to be non-null — and the new row doesn't land in that array until the follow-up `load()`
  resolves a moment later. That unmounted and remounted the modal for one frame, dropping focus and
  re-running its open-focus effect. Gate now only checks `mode !== null`.

Verified: `tsc --noEmit` clean on both packages, 91/91 server tests passing.

## Round 225 — full-codebase bug audit: ~45 fixes across security, data integrity, and the UI
Four parallel exhaustive read-throughs (server services A–I, services J–Z, every route + DB layer +
middleware + MCP, and the entire web frontend), each finding verified against the source before
being touched. Grouped by impact:

**Security / access control**
- `/api/mcp` was reachable by any signed-in household account — every MCP tool proxies to the REST
  API with the instance admin key, so a restricted user could call `set_setting`/`delete_media`
  with full admin rights. Now `requireAdmin` (`app.ts`).
- `routes/collections.ts` had no auth gating at all: a household user could create a smart
  collection over a library they're not allowed into and read every item (including on-disk paths
  via the m3u export), or delete admin-built collections. Writes and the export are admin-only;
  reads filter members through the same allowed-types + content-rating gate as `GET /media/:id`.
  Also validates `smartFilter` (a non-numeric `addedAfterDays` produced `interval 'NaN days'` on
  Postgres and 500'd every subsequent collections listing).
- The auth/login/TOTP rate limiters were keyed on `req.ip`, which behind the shipped nginx is
  always the proxy's own address — one shared bucket, so 10 bad API-key attempts from any stranger
  locked out the real admin for 15 minutes. New `clientIp()` honors `X-Real-IP` only when the direct
  peer is a private/loopback address (so it can't be spoofed from the internet).
- `GET /media/:id/episodes/:episodeId`, `/subitems/:subItemId`, `/subitems/:id/tracks/:trackId` and
  `/watch-state` skipped the library/content-rating checks the parent route applies — sequential
  ids made another library's file paths trivially enumerable. All four now go through one
  `loadVisibleParent()` gate.
- `DELETE /users/:id` could remove the last admin (which silently reopens the unauthenticated
  first-run `/auth/setup`) or the caller's own account; both refused now.
- The public media-server webhook ran `multer()` (in-memory, no limits) *before* checking the
  token — an unauthenticated multi-GB multipart POST was fully buffered into RAM, then 401'd. Token
  check is now a middleware ahead of the parser, and the parser has size/count limits.
- Dashboard widgets (recently added / changed / watched) applied `allowedTypes` but never
  `maxContentRating`; library-group reads weren't scoped to allowed types at all. Both fixed.
- Invite redemption wasn't atomic — two concurrent POSTs on one single-use link (an admin-role
  invite, say) could both pass the `used_at` check and mint two accounts. Now claimed with a
  conditional UPDATE first, released again only if the username turns out to be taken.
- `settingsStore`'s sensitive-key regex claimed to cover every `*Token`/`*Secret` but only matched
  three specific spellings — `mediaServerToken` (the Plex token), `s3SecretAccessKey`,
  `igdbClientSecret`, `traktClientSecret`, `discogsToken`, `hardcoverApiToken` and
  `vapidPrivateKey` were stored plaintext. Widened; the existing startup self-healing re-encrypts
  them on next boot.

**Data integrity / silent misbehavior**
- `importer.ts`'s post-import cleanup `rmSync`'d the imported file's parent folder recursively. For
  a single-file torrent saved straight into a client's category folder (`/downloads/tv/x.mkv`)
  that parent is the shared category folder — every other download in it was wiped. Radarr's rule
  now applies: never remove a folder that still holds other non-sample media.
- Auto-upgrade had no "actually better" gate and no already-queued check: an item below cutoff
  whose indexers only offered its *current* quality was re-grabbed every 6h and re-imported over
  itself (firing "Upgraded" each time), and a still-downloading upgrade was grabbed again on the
  next run. Candidates in the queue are skipped; a grab must strictly out-rank the on-disk quality.
- Per-item "Scan & Import" created a duplicate show/artist instead of attaching to the target when
  the filename-guessed title only loosely matched ("The Office" vs "The Office (US)") — the exact
  duplicate the loose-match comment said it prevented. The target's id is now passed through and
  used as the fallback match.
- "Organize & Rename" used the *import* strategy for library-internal moves: under `hardlink` the
  old file was left behind (library size doubles), under `symlink` the DB ended up pointing at a
  symlink to a symlink. Renames are always real moves now.
- `duplicates.ts`'s repeated-import check grouped on `episodeId`/`subItemId`/`quality` fields that
  no `'imported'` history writer ever recorded — every 24-episode series was reported as "imported
  24 times". The writers record them now.
- qBittorrent's SID cookie was cached forever: after a qBittorrent restart every poll/add/remove
  threw HTTP 403 until AoNarr itself restarted. Now invalidated and retried once on 403.
- SOCKS5 proxy broke every HTTPS request: undici only does TLS itself for an options-object
  `connect`; a custom connector owns TLS, and ours returned the raw tunnel socket, so plaintext
  HTTP went to port 443. The tunneled socket is now wrapped in `tls.connect` for `https:`.
- IRC feeds with SASL never registered: the CAP ACK check required an unprefixed line, but every
  real ircd sends `:irc.host CAP * ACK :sasl`; a NAK'd request was also a dead end; and on TLS the
  handshake fired twice (`connect` + `secureConnect`). Prefixed/NAK forms handled, NICK/USER sent
  alongside CAP REQ, single connect handler.
- IMDb list CSV parsing dropped empty fields, shifting every column after the (almost always
  blank) Description left — `Year` got the genre string, `Title` got the original title. Proper
  positional split now.
- Multi-disc MusicBrainz releases produced duplicate track numbers (each disc restarts at 1) on a
  `UNIQUE(sub_item_id, track_number)` table, so disc 2's titles overwrote disc 1's. Numbered
  continuously across discs.
- Prowlarr sync's `LIKE '%"prowlarrId":5%'` also matched ids 50/500…; terminated on the closing
  brace.
- Scheduled channel/podcast auto-downloads passed the raw snake_case DB row to the adapter, so
  `audioOnly` was always undefined — scheduled yt-dlp grabs fetched full video where manual ones
  fetched mp3. Mapped through `downloadClientFromRow` like `grab()` does.
- Plex watchlist posters were double-prefixed (`https://metadata-static.plex.tvhttps://…`) — Plex
  Discover returns absolute URLs, unlike a local PMS. Only relative paths get the host now.
- Jellyfin/Emby watch sync returned each shared file once per user, recording N duplicate
  `watch_events` rows; collapsed to one per path.
- Range streaming (`rangeStream.ts`) leaked a file descriptor on every client abort (every seek)
  via `.pipe()`; switched to `stream.pipeline`. Suffix ranges (`bytes=-500`, how players read an
  MP4's trailing `moov`) were served as `0-500`. Both fixed.
- Real-Debrid `selectFiles` failure was unchecked and the status poll had no exit, so a dead
  torrent polled every 5s forever with the queue row never resolving; all four in-process download
  adapters also leaked their write stream (and left a partial file the importer could fuzzy-match)
  on a mid-download error. One `saveBodyToFile` helper with `pipeline` + cleanup, and a 6h debrid
  poll deadline.
- Deleted-file check and auto-archival cleared episode/sub-item `has_file` but never rolled the
  parent's back, hiding a fully-vanished series from the Missing views until the next full scan.
- `listActiveSessions` compared ISO `expires_at` against the DB's `YYYY-MM-DD HH:MM:SS` now-string
  as text (`'T' > ' '`), so a session that expired this morning still showed as active all day.
- Album import probed media info at the anchor's *original* filename after the track template had
  renamed it — `media_info` was NULL for every album import with naming on.
- Course scraper's `<meta content=…>` regex stopped at the first apostrophe (`"Everything you"`).
- `wanted.ts` used SQLite-only `substr(x, -2)` for zero-padding — Postgres returned `S001E005`.
- `iptv.ts` playlist `itemCount` was a string on Postgres (one more unwrapped `COUNT(*)`).
- Media-server import's title+year fallback matched two items with *unknown* years trivially
  (`null === null`), folding "Extraction 2" into "Extraction".
- SMTP client accumulated an `error` listener per command; backup download's error callback threw
  outside Express (client hung instead of a 500); library validation crashed on a `has_file=1`
  row with a NULL path.

**Frontend**
- Manual "Grab" sent every release to `clients[0]` regardless of protocol or enabled state — an
  NZB to qBittorrent, or to a disabled client — and the three `grab()` functions had no error
  handling, so the failure was silent. The server now picks an enabled client by the release's
  protocol when no id is given; the UI sends the protocol and reports failures.
- Calendar month grid and Dashboard "Upcoming" built dates with `toISOString()`, which converts to
  UTC first: every cell was one day off east of UTC, and "today" was tomorrow for evenings west of
  it. Local date formatting everywhere.
- A–Z jump sidebar ignored the active search query (page math against the unfiltered index
  landed on an empty page); the library list had no out-of-order response guard (fast "Series"
  response overwritten by the slower "Movies" one) — both fixed.
- Escape closed every open modal, not just the topmost (FolderPicker inside Add Root Folder
  discarded the parent form). Modals now track a stack and only the top one reacts.
- MediaDetail kept the previous item's History panel/seasons open when navigating item → item;
  AddMedia carried a ROM group id into a movie added after switching types; Discover keyed cards
  by title alone (remakes collided); GlobalSearch/Indexers "Test all" left unhandled rejections /
  a stuck "Testing…" state; the Plex sign-in poll ran forever and past unmount.

Verification: `tsc --noEmit` clean on both packages; full server suite in a disposable
`node:20-slim` container; local Docker test stack rebuilt and smoke-tested.

## Round 224 — Postgres bulk-rename count bug, found by a dedicated audit pass
- With the Servarr-parity redesign thread fully closed out, ran a dedicated bug-hunting pass (a
  background subagent read broadly across `server/src/services/`, `server/src/routes/`, and the
  dual-dialect DB layer, then went deep on the most suspicious spots) instead of inventing more
  visual-parity work. Found one genuine, reachable bug.
- `services/importer.ts`'s `renameLibraryFiles()` — the bulk "Organize & Rename" operation — added
  `count.c` (a `SELECT COUNT(*) AS c ...` result) straight into `result.skippedMusic` without a
  `Number()` wrap, the one call site in the whole codebase that skipped it (every other `COUNT(*)`
  site already wraps correctly — `media.ts`, `childCounts.ts`, `metrics.ts`, `system.ts`,
  `upgradeCandidates.ts`). Harmless on SQLite (returns a real `number`), but on Postgres `node-pg`
  returns `COUNT(*)` as a **string**, so `+=` silently switched to string concatenation
  (`"0" + "3"` → `"03"`, then `"03" + "12"` → `"0312"`) — a Postgres admin running a bulk rename
  across more than one Music album with existing files would see a garbage "skipped Music item(s)"
  count in the response instead of the real sum. One-line fix: `Number(count.c)`.
- Also fixed a stale doc comment the same audit flagged in passing: `db/asyncDb.ts`'s header still
  claimed the async DB layer was "NOT WIRED INTO THE APP YET," left over from Round 102's original
  phase-1 design — `db/index.ts` has wired it in as the sole `db` export for ~100 of ~102 route/
  service files since that same round. Left future readers correctly warned that Postgres-dialect
  bugs in this layer are live, not theoretical (this round's own finding being the proof).
- Verified via the full server test suite in a disposable `node:20-slim` container (clean
  `node_modules` reinstall, not a bind-mount, per this session's established native-binding
  workaround): 91/91 tests pass, both before confirming the bug's shape and after the fix.

## Round 223 — sortable headers inside Settings' render-callback tiles
- The one deliberately-skipped item from Round 222: `Settings.tsx`'s four small config list tables
  (Blocklist, Tags, Format Scores, Import Exclusions) live inside `SettingsSectionTiles`' `render: ()
  => (...)` callbacks — `openSection.render()` is invoked as a plain function call, and only the
  currently-open section's callback runs, so calling `useSortableTable` directly inside one would
  violate the rules of hooks (same bug class fixed for `Users.tsx` in Round 215).
- Fixed the right way instead of skipping again: extracted each table into its own real component
  (`BlocklistTable`, `TagsTable`, `FormatScoresTable`, `ImportExclusionsTable`), each taking the
  already-loaded data and callbacks as props and calling `useSortableTable` in its own function body.
  `render: () => <TagsTable ... />` now returns a mounted component instance instead of invoking a
  hook inline, so React owns that component's own hook order — no violation. The transient
  Test-Custom-Formats match-results table was left alone (one-off output, not a persistent list).
- Live-verified against the local Docker test stack: created two tags via direct API calls
  (`Zebra Tag`, `Apple Tag`), opened the Tags settings tile, and confirmed the table defaulted to
  alphabetical order (Apple before Zebra) with the "Name ▲" arrow indicator showing — the same
  sort-hook behavior already proven across 20+ other pages this session. Cleaned up the test tags
  afterward. `npx tsc --noEmit` clean.
- This was the last carve-out from the "make every page match Sonarr/Radarr/Lidarr/Readarr/
  Whisparr" plan — every list table in the app is now sortable except the two still deliberately
  out of scope (`LibraryType.tsx`'s server-side sort dropdown, `Dashboard.tsx`'s fixed-recency
  widgets) and the truly non-list detail/manually-ordered tables.

## Round 222 — one more sortable-header catch, closing the Round 215 plan for good
- Full sweep of every page for a plain `<table>` not yet using `useSortableTable` turned up one
  more: `DownloadClients.tsx`'s Remote Path Mappings sub-table (Client / Remote path / Local path)
  — a bonus catch not on the original Round 215 file list, added for the same reason as every other
  conversion this thread has done.
- Confirmed the remaining plain tables are deliberately out of scope: `LibraryType.tsx`'s Table
  view is driven by a server-side sort dropdown (not per-column client-side sort — a different,
  more capable mechanism, not a gap), `Dashboard.tsx`'s widgets are fixed-recency glance lists
  (sorting would defeat their purpose, same as real Sonarr's dashboard), and `Settings.tsx`'s
  handful of small config tables live inside `render: () => (...)` callbacks from the
  `SettingsSectionTiles` pattern — the exact hooks-rules-violation shape fixed in Round 215's
  Users.tsx, so wiring a hook in there needs its own component-extraction pass rather than a quick
  addition here.
- Live-verified against the local Docker test stack (`docker compose up -d --build aonarr-server`
  to pick up the change, since the container had been running a pre-Round-214 image without the
  remote-path-mappings route at all — caught as a 404 during this test, not a regression):
  created a test download client and two mappings via the UI/API, confirmed the table defaults to
  sorting by Client, and clicking "Remote path" re-sorted the rows (Apple before Zebra) with the
  arrow indicator moving to the clicked column. Cleaned up the test client afterward.
- This closes every item from the original "make every page match Sonarr/Radarr/Lidarr/Readarr/
  Whisparr" request: nav icon rail, poster-grid conversions, and sortable columns are now
  consistent across the entire app.

## Round 221 — last two sortable-header holdouts
- Closed out the Round 215 sortable-column plan: `NetworkStats.tsx`'s two tables (download-client
  bandwidth totals, queue-by-status breakdown) were the last real list tables in the app still
  using plain static `<th>` headers. Wired both into the shared `useSortableTable` hook — Client/
  Uploaded/Downloaded/Ratio and Status/Count/Size are all clickable now, same arrow-indicator
  pattern as every other converted table.
- Audited the two remaining plain tables the plan flagged and confirmed both are correctly *not*
  sortable rather than missed: `TrackDetail.tsx`'s table is a single-row key/value detail view (no
  list to sort), and `IptvPlaylists.tsx`'s two tables (attached filler-clip rotation order, playlist
  items) are manually reordered via explicit Up/Down controls — sorting would fight the position the
  admin just set. `Duplicates.tsx`'s per-group item tables were left alone too: each group only ever
  has a couple of rows, and they're rendered per-group inside a `.map()`, so a shared sort hook
  wouldn't cleanly apply per-instance.
- Live-verified in the Docker test container: logged into a fresh admin session (reset the test
  container's `admin` password directly in its sqlite db via the server's own scrypt hashing since
  the session token from earlier rounds had expired), opened `/network-stats`, and confirmed
  clicking "Count" moved the sort-arrow indicator from the default "Status ▲" to "Count ▲".
  `npx tsc --noEmit` clean.

## Round 220 — the last few plain "Yes"/"No" monitored columns
- Grepped the whole codebase for the literal pattern that started this whole thread
  (`monitored ? "Yes" : "No"`) and found three stragglers `MonitorToggle` hadn't reached yet:
  `Duplicates.tsx`'s per-candidate comparison table (added a new `toggleItemMonitored` using the
  same `PATCH /media/:id` call every other per-item toggle already uses), and the single-row
  detail tables on `EpisodeDetail.tsx`/`SubItemDetail.tsx` — both of which already had a separate
  "Monitor"/"Unmonitor" button below the table, now sharing that exact same handler so the icon
  and the button can never disagree. That grep now returns nothing — every monitored indicator in
  the app is the same clickable icon.
- Live-verified: on `EpisodeDetail.tsx`, clicked the new icon directly and confirmed the button
  below it flipped from "Unmonitor" to "Monitor" in the same render, proving both point at the
  same state. Tried to seed a real duplicate pair to verify `Duplicates.tsx` visually too, but the
  metadata-import endpoint correctly rejects a same-title-and-year duplicate with 409 — confirms
  that safeguard works, just not useful for forcing a test fixture; that one file's change is a
  one-line swap of an already-proven component, checked by code review and a clean typecheck
  instead.

## Round 219 — season-level monitor toggle, replacing the Monitor/Unmonitor button pair
- Extended last round's `MonitorToggle` to the season level on `MediaDetail.tsx`'s episode list:
  the season header's separate "Monitor"/"Unmonitor" text buttons are now a single icon — filled
  when every episode in the season is monitored, outline otherwise — clicking it calls the same
  `toggleSeasonMonitor` bulk endpoint that pair already used. Also added the same icon as a poster-
  corner overlay on the season "Tiles" view, matching the per-episode/per-item placement from last
  round. Real Sonarr does this identically: one icon that reflects and sets the whole season's
  state, not two separate buttons.
- Live-verified with a real series + 2 episodes created via the manual episode-add endpoint
  (`POST /media/:id/episodes` — no metadata provider needed for a from-scratch test item): toggled
  the season icon off (both episodes flipped to unmonitored, confirmed via each icon's title
  attribute), then back on, and confirmed the `PATCH /media/:id/season/:n/monitor` call succeeded
  both times. Also confirmed the season-tile view's corner overlay renders correctly. A couple of
  unrelated 400s on `/cast` and `/alternate-titles` showed up in the console during testing — traced
  to the test series having no real TMDB id (expected for a manually-created item), not a
  regression from this change.

## Round 218 — clickable monitor toggles, matching Sonarr/Radarr/Lidarr's poster-corner star
- **New: `components/MonitorToggle.tsx`** — a small bookmark-ribbon icon (filled when monitored,
  outline when not) that toggles monitored status with one click, without navigating into the
  item — exactly the affordance Sonarr/Radarr/Lidarr use on their season/episode/album lists
  instead of making you open a detail page just to flip one flag. Every "Monitored" column in the
  app used to be plain "Yes"/"No" text; this replaces all of them:
  - `LibraryType.tsx`: all three views — a corner overlay on the poster-grid card (Sonarr's actual
    placement), next to the poster thumbnail in Overview view, and in the Monitored column of
    Table view. Added a shared `toggleItemMonitored()` reusing the same `PATCH /media/:id` call
    the existing single-item detail toggle already used.
  - `MediaDetail.tsx`: the per-episode Monitored column (season accordion tables) and a new
    Monitored column on the collection-children table (albums/books under an artist/author) that
    didn't have one before at all — both wired to the same per-item PATCH endpoints
    EpisodeDetail.tsx/SubItemDetail.tsx already used for their own single-item toggle buttons.
- Live-verified end-to-end: created a real test movie via the metadata-import endpoint (to get an
  actual poster to click on, since a fresh instance has nothing seeded), toggled it in all three
  Library views, and confirmed the icon flips filled↔outline, the poster-banner text updates
  (Missing↔Unmonitored) in step, and — critically — clicking the toggle never triggers the row's
  own click-to-navigate handler.

## Round 217 — sortable tables on the rest of System's tabs
- Finished the sweep started last round: Maintenance (upcoming archivals, orphaned files, renamed
  files, rename errors, unmonitored-with-no-file cleanup candidates) and Insights (disk space,
  media-server library-validation mismatches) tabs now use the same `useSortableTable` pattern as
  everywhere else. That's every genuinely list-shaped table on the System page now sorted —
  14 in total across this round and the last. Left alone, deliberately: system info and library
  counts (both single-row key/value displays) and the per-duplicate-group file-compare table
  (2-3 rows, same reasoning as Duplicates.tsx's own compare table — nothing to usefully sort).
- Live-verified in a fresh Docker test instance: clicked through Maintenance and Insights, and
  exercised "Load reputation stats"/"Run validation" directly (found a stale 500 in the browser
  tab's console-message buffer while checking for regressions — traced it to leftover history from
  much earlier in this same long-lived test session, not a real error; confirmed by re-triggering
  both actions fresh and getting clean 200s with correct empty-state messages).

## Round 216 — sortable tables on System's Health tab
- Closed out the gap flagged at the end of Round 215: System.tsx has ~15 tables and only 2
  (release-group reputation, log files) got the `useSortableTable` treatment before. Added it to
  the rest of the Health tab — indexer health, download client health, stuck queue items, repeated
  imports, and upgrade candidates — since those are the ones that can genuinely grow into long
  lists on a big library. Left System's other small/summary tables (system info, library counts,
  disk usage, root-folder-scoped orphan/rename lists) alone, same reasoning as before: real
  Sonarr/Radarr doesn't make single-digit status tables sortable either.
- Live-verified the Health tab's new sortable headers render and the sort-arrow indicator shows
  correctly in a fresh Docker test instance.

## Round 215 — Servarr-style navigation icons, sortable tables, and a poster-grid Collections page
- **Icon-led navigation, matching Sonarr/Radarr/Lidarr's chrome.** Every sidebar/topbar nav link
  (including each per-media-type Library entry and every admin group) now shows a small inline SVG
  icon next to its label (`components/NavIcons.tsx`, ~30 stroke icons, no new dependency). The
  collapsed sidebar state changed from "hidden behind a hamburger" to a proper Sonarr-style
  icon-only rail (`.sidebar--collapsed` in styles.css) — its own ☰ toggle expands it back, and the
  floating hamburger button is now mobile-only, where a full overlay sidebar is still the right
  affordance. AoNarr's own color palette, and the existing sidebar/topbar + centered/full-width
  layout toggles, are all untouched — this is chrome, not a rebuild.
- **Sortable columns on every plain-list table that was missing them.** Only Activity.tsx's queue
  table had click-header-to-sort before this round; extracted its exact shape into a shared
  `useSortableTable` hook (`web/src/hooks/useSortableTable.tsx`) and applied it across ~20 pages —
  Missing, Cutoff Unmet, History, Blocklist, Import Review, Recycle Bin, Requests, Watchlist
  Import, Jobs, Audit Log, Media Analyzer, Indexers, Friend Libraries, Import Lists, three tables
  on Users (Invite Links/Active Sessions/Request Stats), two on System (release-group reputation,
  log files), and the manual-search-results tables on Media/Episode/SubItem Detail. Deliberately
  left unsorted where order is inherently meaningful (an IPTV playlist's rotation position, an
  episode list's episode order, a duplicate-group's 2-3-item compare table) or the table is a
  small, mostly-static status summary (Network Stats, most of System's own diagnostics) —
  matching real Sonarr/Radarr behavior, which doesn't make those sortable either.
- **Collections is now a poster grid**, not a table — matching every other "browse a set of
  titles" page (Library, Person, Dashboard's Recently Added). Added a small backend addition to
  support it: `GET /collections` now returns each collection's first 4 member poster URLs
  (`server/src/routes/collections.ts`), rendered as a 2×2 mosaic per card, falling back to a
  plain icon tile for an empty collection.
- **Caught and fixed a real hooks bug while building this**: three of the new sortable tables
  (Users' Invite Links/Sessions/Request Stats) originally lived inside `SettingsSectionTiles`'
  config-array `render: () => (...)` callbacks, which are invoked as plain function calls inside
  JSX rather than mounted as their own components — calling a hook in there would have attributed
  it to the wrong component and run it conditionally, violating React's rules of hooks. Fixed by
  extracting each into its own proper component (`InvitesTable`, `SessionsTable`,
  `RequestStatsTable`) before adding the hook, and audited every other page for the same pattern
  before shipping (`grep -n "render: () =>"` across every touched file) — none of the others use
  it, confirmed live afterward (no "rendered more hooks than during the previous render" warnings,
  and Users' three tables all sort correctly independent of which one is open).
- Live-verified navigation icons and the icon-only collapsed rail (both sidebar and topbar mode),
  clicked through several converted tables to confirm columns actually reorder rows on click, and
  reran the full server test suite (91 tests, via the disposable-container workaround for this
  machine's broken Windows `better-sqlite3` binary) after the collections.ts change.

## Round 214 — remote path mappings for download clients
- **New: Radarr/Sonarr-style remote path mappings.** Investigated a handful of Radarr/Sonarr
  features AoNarr didn't have yet (FlareSolverr, seed-ratio cleanup, tags, queue priority, backup/
  restore — all already present) and found one genuine gap: nothing translated a download client's
  own reported path when it doesn't share AoNarr's exact filesystem layout. Turned out the deeper
  story was that AoNarr's importer never asked the client for a path at all — it fuzzy-matches the
  release title against every file under the shared downloads directory, which works but can't
  help a client on a different host/mount. Added the real mechanism: qBittorrent's
  content_path/save_path and SABnzbd's history "storage" field are now captured per download,
  rewritten through any configured remote_path → local_path mapping (Settings-adjacent "Remote
  Path Mappings" section on the Download Clients page — client dropdown, two path fields, a table
  of existing mappings), and stored on the queue row. The importer now searches that download's own
  specific file/folder first — more accurate even with zero mappings configured, since a season
  pack's files no longer compete against every other in-flight download for best fuzzy-match score
  — falling back to the original downloads-directory-wide scan whenever no mapping applies or the
  translated path doesn't exist, so the existing shared-volume setup every current install uses
  keeps working identically.
- **New test file** (`server/tests/remotePathMapping.test.ts`, 7 cases: prefix rewrite, exact
  match, case/slash-style tolerance, longest-prefix-wins when mappings overlap, per-client
  isolation, and the untouched-passthrough default) plus the full existing suite (91 tests total)
  re-run in a disposable Linux container — this machine's local `better-sqlite3` binary can't run
  DB-backed tests at all on Windows, so a scratch `node:20-slim` container with the repo copied in
  (not bind-mounted, to avoid cross-platform native-binary contamination) stood in for CI. Also
  live-verified the new Settings UI end-to-end in a Docker test instance: added a download client,
  added/listed/deleted a mapping, confirmed the client-name lookup and table rendering all work.

## Round 213 — route-based code splitting, and the label/input accessibility pass
- **Frontend bundle split by route**: every page except Dashboard/Onboarding is now `React.lazy`-
  loaded behind a `<Suspense>` boundary instead of sitting in one eager bundle — cuts the main JS
  chunk downloaded before a user clicks anything from 641KB to 212KB (gzip: 174KB → 67KB), with the
  rest (Settings, API Docs, every library/media page, etc.) fetched only when actually navigated to.
  Live-tested via the Docker test-container workflow: logged in, navigated through Settings,
  Calendar, and API Docs via normal in-app links, confirmed each lazy chunk loads cleanly with no
  console errors. (A hard full-page reload of `/api-docs` specifically hits a pre-existing Vite
  dev-proxy quirk — its `/api` proxy prefix string-matches `/api-docs` too — but that's dev-only;
  production is served by nginx with exact routing, and in-app navigation is unaffected either way.)
- **Wired up the label/input accessibility gap flagged last round**: a spot-check then found 0 of
  27 form labels on the Settings page properly associated with their input via `htmlFor`/`id` —
  clicking a label did nothing, and screen readers couldn't announce which control a label
  described. Fixed across every page with the pattern (Settings, Users, Download Clients,
  Indexers, IRC Feeds, IPTV Playlists, System, Add Media, Media Detail, and a dozen more — ~270
  `<label>`/`<input>` pairs in total). Checkbox-group headings (e.g. "Library access", "Allowed
  qualities") that don't map to one single control instead got `role="group"` +
  `aria-labelledby`, the correct pattern for a group of already-self-labeled checkboxes.
  Live-verified in the browser rather than trusting the mechanical pass blind: opened the Add User
  modal and confirmed clicking the "Password" label actually moves focus into the password field,
  and swept every rendered page for duplicate `id`s — caught and fixed two real ones this pass
  introduced (Settings' per-media-type default-provider `<select>` and GroupPicker's per-level
  dropdown both render inside a loop, so their label/input ids needed to be keyed per item instead
  of a single static string, or every iteration after the first would collide).

## Round 212 — a movie-shaped Sports PPV library
- **New library type: Sports PPV**, sitting alongside last round's Sports type rather than folded
  into it — a weekly broadcast (Raw, a league's regular season) is naturally episodic and fits
  Sports well, but a pay-per-view (WrestleMania, a numbered UFC event) is a single self-contained
  release with its own poster/title/year and no recurring-show structure, a movie in every way that
  matters here. Modeled on Movies' shape and provider list exactly (TMDB/OMDb/Trakt) — TMDB
  genuinely catalogs many PPVs as standalone entries, so this needed no new provider integration
  either, same as Sports itself last round. Wired into the same handful of places Sports was:
  artwork lookup, cast/trailer fetch, corrupt-file detection, TRaSH-guide sync, media-server
  import, TMDB-id matching, and the UI affordances that check media type explicitly.
- **Live-tested this one properly before shipping** — built and ran a local server image, drove the
  Add Media flow for both new types through the actual browser, and caught two real bugs doing it:
  Sports PPV's TMDB search and Sports' own Trakt search both failed with "No search implementation
  for provider" instead of reaching the real API (a type-specific provider-function table needed
  entries for the new types that weren't there — the Trakt/Sports one was a latent bug from last
  round, not something this round introduced, just surfaced by testing more thoroughly this time).
  Fixed both; re-verified live that each now fails with the correct "API key not configured"
  message instead of the wrong error, confirming they reach the real search code.

## Round 211 — a Sports library, episode-import parity, a real mobile bug fixed
- **New library type: Sports** (WWE, UFC, league broadcasts, etc.) — modeled as an episodic type,
  the same shape TV Shows already uses: a promotion/league is the "series," each event/match/
  broadcast is a dated "episode." This is deliberately how TVDB and TVmaze already catalog this
  exact content themselves (WWE Raw, UFC events, and so on are real entries there) — so Sports
  reuses the identical series search/episode-fetch code with zero new provider integration, which
  means it gets every filter/sort/quality-profile/custom-format/naming/monitoring feature TV Shows
  already has, for free. TheSportsDB (a sports-specific database) was investigated as a metadata
  source and found not viable as a default: live-checked its free tier and found it's a locked demo
  (10 soccer leagues total, 1-result search caps) with real coverage gated behind a paid key —
  TVDB/TVmaze/Trakt are what's actually wired up, matching TV Shows' own provider list. Also wired
  into artwork lookup (Fanart.tv), corrupt-file detection, TRaSH-guide custom format sync, Plex/
  Jellyfin/Emby library import, and the .plexmatch/artwork UI affordances — the same handful of
  places a couple of earlier rounds found still keyed off an explicit `type === "series"` check
  instead of reading from the shape-driven registry.
- **Episode-page Manual Import now matches the movie/series page's**: any-folder browsing and the
  AI "Identify" button from last round, previously only on the richer batch picker.
- **A real mobile bug, caught and fixed**: built and ran the app in an isolated local Docker
  container (this dev machine can't run the DB-backed server directly — see prior rounds) and drove
  it live at a 375px mobile viewport. Found the fixed ☰ sidebar-toggle button overlapping every
  page's own heading (visibly: "Dashboard" rendered as "shboard," the button sitting on top of the
  first few letters) — `.content`'s mobile padding wasn't accounting for the button's height. Fixed
  with more top clearance; verified live afterward, plus spot-checked several other pages (Library,
  Activity, System, Indexers, Users) for horizontal overflow — none found, the existing responsive
  foundation held up.
- **Accessibility spot-check**, also verified live rather than guessed at: Modal's focus trap/
  aria-modal/labelled-close-button held up under inspection, no `outline: none` anywhere suppressing
  focus indicators, and `--muted` text against the dark background computes to a 5.7:1 contrast
  ratio (passes WCAG AA's 4.5:1 for normal text). The one real, sizable finding: essentially no form
  `<label>` in the app is programmatically associated with its input (no `htmlFor`/`id` pairing or
  nesting) — confirmed live (27 of 27 sampled inputs on Settings had zero association) — meaning a
  screen reader gets no context on most fields. This is a genuine gap, not a small one (hundreds of
  instances across the whole app), and fixing it safely needs to be its own dedicated pass rather
  than a rushed mechanical sweep at the tail of this round.

## Round 210 — AI-assisted identification, Manual Import redesigned
- **The AI Providers feature is finally wired to something**: Settings → AI Providers (add a
  local Ollama-style or cloud OpenAI-compatible provider, test the connection) has existed for a
  while, but nothing in the app ever actually called it — `queryAi` had zero real callers. Manual
  Import now has an "🤖 Identify" button per file: for video, it grabs a frame ~25% into the file
  and asks the configured vision-capable model what movie/show (with season/episode if visible) it
  looks like; for audio, since a general chat-completion API has no way to actually listen to a
  clip through this integration, it reads the file's own embedded ID3/Vorbis tags with ffprobe and
  asks the model to make sense of/clean up whatever's there. Either way it's a text suggestion for
  a human to read and act on in the normal picker — it never applies a match on its own. Falls back
  to a filename-only guess when frame extraction fails or an audio file has no tags.
- **Manual Import is now a popup**, matching the Manual Search popup from last round instead of an
  ever-growing inline section — the batch file-browser/target-picker on a movie/series/album page,
  and the simpler single-file picker on an episode page.
- **Manual Import can now browse and import from any folder**, not just the downloads directory —
  a text field to jump to an absolute path, same trust level (admin-only) as the root-folder
  picker's own already-unrestricted directory browsing. Scoped to the movie/series/album page's
  richer batch picker; the simpler per-episode picker stays downloads-only for now.
- Modeled after Radarr/Sonarr's own Manual Import/Interactive Search screens in shape — a popup,
  per-file target/quality picking, batch import with per-file results — not a pixel clone of
  either app's actual UI.

## Round 209 — import-list filtering, search results as a popup
- **Import-list genre/rating/vote-count filtering** (the gap flagged at the end of Round 208): a
  list still adds everything it has by default, but each list can now set a minimum rating,
  minimum vote count, and/or excluded genres to narrow what it actually adds — Trakt (via
  `extended=full`, which is what actually puts rating/votes/genres on a Trakt list item), IMDb
  (its CSV export's own Rating/Num Votes/Genres columns), and TMDB (`vote_average`/`vote_count`,
  plus a static id→name map for `genre_ids` — TMDB's genre list is stable enough that resolving it
  doesn't need an extra API call per sync). Last.fm's top-artists source has no rating/vote/genre
  data to filter on, so those fields are hidden for that type rather than implying they do
  something. An item whose rating/votes/genres aren't known from its source is never excluded over
  missing data — same default the size-cap and custom-format size conditions already use. Added
  pure unit tests for the shared filter-evaluation function.
- **Manual search results on a media/episode/album page are now a popup**, not an ever-growing
  section pushing the rest of the page down — the same pattern already used for manual import and
  add-media flows elsewhere in the app. No change to the search/grab logic itself, just where the
  results render.

## Round 208 — per-profile maximum release size
- **Quality profiles can now set a hard maximum release size**: independent of the existing
  per-quality min/max size bounds (which only compare a release against the range configured for
  the specific quality it parsed as), a profile can set a flat ceiling — any release over it is
  rejected outright, regardless of which quality it is. Enforced in `scoreRelease`, the single
  function both the automatic grab pipeline and the manual Search page's result annotations
  already share, so this applies consistently everywhere a release gets scored, with no separate
  filter logic to keep in sync. Skipped when a release's size isn't known at all (same
  "don't reject on missing data" default the existing per-quality size condition type already
  uses). New "Maximum size (GB)" field on each quality profile in Settings, blank/no limit by
  default. Added test coverage (rejects over the limit, allows within it, no-op when unset, no-op
  when size unknown).
- **Gap-checked** against Radarr/Sonarr/Lidarr/Readarr/Youtarr/Whisparr again; the one real find —
  Radarr's import-list genre/rating/vote-count filtering has no equivalent here (AoNarr's import
  lists add everything the source list has, unfiltered) — is sizable enough to be its own round
  rather than folded into this one.

## Round 207 — Search page also searches metadata providers to add new media
- The Search page only ever searched the existing library — finding something to add still meant
  navigating to Add Media separately and re-typing the query there. It now fires both searches in
  parallel: the existing library search, plus one metadata-provider search per library type that
  has one configured (TMDB, TVDB, MusicBrainz, Open Library, etc. — whatever each type's provider
  is), shown in a new "Add new" section below the library results. A type with no provider
  configured (a missing API key, or a type like Courses that only supports manual add) just
  contributes nothing to that section rather than surfacing an error for every other type's
  results. Results already sitting in the library (matched by title in the search above) are
  filtered out of "Add new" so it doesn't suggest adding something twice. Clicking a result takes
  you to Add Media with the type and title already filled in, to finish through the full add flow
  (root folder, quality profile, monitoring) — this reuses the same deep-link prefill Add Media
  already supported for Friend Libraries' "Add" button, not new server-side surface. Admin-only,
  matching Add Media itself (a household account never sees this section, and the underlying
  `/metadata/search` route was already admin-gated).

## Round 206 — the download queue actually clears itself out
- **Fixed: successful imports left the queue growing forever.** A queue row was left at
  status='imported' after a successful import rather than removed — every import ever made just
  accumulated in the Activity page's queue table with nothing to clear it out. The `history` table
  already records the same "imported" event permanently (that's what the Activity page's History
  section reads from), so the queue row is now deleted outright once import succeeds — same fix
  applied to the old 'failed' row left behind whenever an auto-retry successfully grabs a
  replacement release (it was never removed, just orphaned alongside the new grab's row). A
  'failed' row that's never acted on (no retry, no manual import, no manual removal) is now also
  pruned automatically after a week, so it doesn't sit there forever either — its own `history`
  entry already has the permanent record.
- **Fixed: nothing removed a finished download's files or client-side task.** Once a file was
  imported, its leftover release folder (samples, .nfo, junk, the emptied folder itself) just sat
  in the downloads directory permanently, and the finished torrent/nzb stayed at the download
  client forever too — the only existing cleanup (seed-goal cleanup) only ever ran for torrents
  with a configured seed ratio/time goal. Added real cleanup: after a successful import, the
  release folder is deleted and the download is removed from its client (qBittorrent, SABnzbd —
  the two adapters that support it; others are left alone, no API to do this). Deliberately
  scoped by download-safety, not just success/failure: skipped entirely for Hardlink/Symlink import
  strategies (their whole point is keeping the original data around), and never touches a file when
  the failure happened *after* a download completed (an import-matching error) — that file is
  exactly what Manual import... needs to still be there. A download that fails *at the client
  itself* (dead torrent, failed usenet repair) has nothing worth keeping, so that path *does* clean
  up immediately. Both behaviors are configurable (Settings → Download Cleanup), on by default.
- **Activity page redesign**: split into a filterable/sortable Queue section (status filter,
  click-to-sort columns) and a renamed History section with an event-type filter and a title/detail
  search box, closer to Radarr's own Activity screen. The queue naturally reads very differently
  now that it isn't full of years of resolved items — this made the filters and sort actually useful
  instead of decorative.

## Round 205 — library UI polish
- **"Filename doesn't match title" library filter**: a new Status filter option flags movies (and
  other single-file library types) whose actual file on disk shares fewer than half its
  significant words with the matched title — catches a bad indexer match, a manual import into the
  wrong item, or a file that was moved/renamed outside AoNarr. Scoped to `media_items.path` only;
  series/music/book-style items spread files across episodes/sub_items instead, each with its own
  title to compare, which needs a different UI (an episode/track list) than the library grid this
  filter lives on.
- **Removed the redundant status text under poster cards**: the poster grid already shows a
  colored Downloaded/Missing/etc. banner across the poster itself — the "Poster info" field for
  Status was *also* repeating that as plain text underneath, which was pure duplication. Still
  shown in Overview (row) view, which has no banner of its own.
- **Named root folders**: Library Sync's root folder tiles showed the raw filesystem path as the
  tile label, which gets unwieldy with several folders on similar-looking paths (`/media/movies`
  vs `/media/movies-4k`). Added an optional display name per root folder — the tile, and the
  "move all files to another root folder" destination picker, now show it instead of the path when
  set, falling back to the path exactly as before when it isn't.

## Round 204 — graceful shutdown
- **`docker stop` no longer just kills the process mid-work**: there was no SIGTERM/SIGINT handler
  at all — Node's default disposition for those signals is immediate termination, whatever a
  scheduled job (an import, a library scan) happened to be doing at that instant. On shutdown, the
  server now stops scheduling new job runs, cooperatively cancels whatever's already mid-run via
  the existing per-job `AbortSignal` (jobRegistry.ts already had this wired for cancel-from-UI; it
  just wasn't invoked on shutdown), stops accepting new HTTP connections, and closes the database
  cleanly — bounded to a 5s grace period rather than waiting indefinitely, since a long-lived
  connection (the Activity page's log-tail EventSource) would otherwise be able to block
  `server.close()`'s callback from ever firing. The combined image's entrypoint already forwarded
  SIGTERM to the node process correctly (`trap ... TERM INT`) — this was purely a gap in what node
  itself did upon receiving it.
- **Investigated, already fine**: log rotation/retention was already in place (daily log files,
  7-day retention, pruned on day rollover) — no change needed. A broader structured
  request-validation layer (e.g. zod across all routes) was also considered but deferred: with
  ~50 route files each hand-checking their own inputs today, that's a large, risky rewrite better
  done deliberately as its own effort than folded into this round.

## Round 203 — indexer network resilience, a real Content-Security-Policy
- **Retry transient indexer network failures**: a single dropped connection, DNS blip, or timeout
  talking to an indexer previously failed that entire search attempt outright. `fetchIndexerText`
  (the shared HTTP call behind torznab/newznab/RSS search and the FlareSolverr proxy path) now
  retries once, after a short delay, but only for connection-level failures (timeout, ECONNRESET,
  ECONNREFUSED, DNS failure) — never for a real HTTP response an indexer sent back (a 429/403/500
  still fails immediately and feeds the existing backoff logic, unchanged).
- **A Content-Security-Policy that actually does something**: Round 201 added `helmet` with
  `contentSecurityPolicy: false` on the API server — investigating further this round found that
  was close to a no-op for browser security regardless, since the API server never serves the HTML
  page at all; nginx does (see web/nginx.conf.template, combined/nginx.conf), and a CSP header has
  to be on the document response to protect it. Added a real CSP there instead: strict `script-src
  'self'` (no `unsafe-inline`/`eval`), which meant pulling the one inline `<script>` in index.html
  out into a real file (`theme-init.js`) since CSP can't otherwise tell a legitimate inline script
  from an injected one. `style-src` keeps `unsafe-inline` (React's `style={{...}}` renders as
  inline style attributes everywhere in this app — removing that is a much bigger refactor than
  this change), `img-src` stays wide open to any origin (posters/backdrops/artwork can come from
  wherever an admin points a metadata provider or media server), and `frame-ancestors` is
  deliberately left unset so embedding in dashboard tools (Organizr, Homarr, Heimdall) keeps
  working exactly as before. Verified against a built production bundle served with the real
  header — no CSP violations in the console, Swagger UI's dynamically-loaded same-origin bundle
  still works.

## Round 202 — encrypted credentials survive backup/restore
- **Backup bundles now include the encryption key**: Round 201 added encryption-at-rest for
  settings credentials (API keys, download-client/SMTP passwords, webhook URLs), with the key
  stored in a file separate from the database by design. That meant the existing backup/restore
  feature — which only ever snapshotted the database — silently left every credential permanently
  undecryptable after a restore onto a different config volume (a real scenario: a fresh Docker
  volume, a rebuilt host, migrating to a new machine). Backups (manual download, and the scheduled
  local/S3 job) are now a small bundle containing the DB snapshot plus `encryption.key` when one
  exists; restore writes the key back into place before/alongside the DB swap, on both SQLite
  (file write before the process restart) and Postgres (write + in-process key-cache reload, since
  that path keeps running against the restored DB immediately). Old single-file `.db`/`.dump`
  backups from before this change still restore correctly for backward compatibility — they just
  won't carry forward a key, same failure mode as before for credentials saved after that backup
  was made. Verified the zip round-trip (write, magic-byte detection, entry extraction) against a
  real `adm-zip` instance before shipping. Also fixed a latent bug found while touching this code:
  S3 remote-backup rotation only ever matched `.db`-suffixed keys, so Postgres's `.dump` backups
  were uploaded but never rotated out — now matches any backup this instance has produced.

## Round 201 — test coverage, security hardening, observability
- **Unit tests for core business logic**: `releaseParser.ts`, `naming.ts`, `quality.ts`, and
  `customFormatScoring.ts` (including the new indexerFlag condition and release-profile
  rejection/scoring) had zero test coverage before this round — the test suite was 2 files total,
  both DB-integration tests, with nothing covering the pure parsing/scoring/ranking logic that's
  actually the cheapest and highest-value code to unit test. Added ~60 new test cases across 4
  files. Verified end-to-end against a real engine before shipping (the pure-function suites run
  and pass locally; the DB-backed ones run in CI, same as the two pre-existing test files, since
  this dev machine's better-sqlite3 binary isn't built for it — matches this project's existing
  local/CI split).
- **Encryption at rest for `settings` table credentials**: indexer/metadata-provider API keys,
  download-client passwords stored in Settings, SMTP passwords, notification webhook URLs/tokens,
  and the instance's own admin API key were stored in plaintext in the database. Now encrypted
  (AES-256-GCM) with a key in a separate file next to the database (`encryption.key`, never in the
  DB itself — encrypting a value with a key stored in the same table it protects defends against
  nothing). Existing installs get a one-time, automatic re-encryption of legacy plaintext values on
  first boot after upgrading — no re-entering credentials by hand. A decrypt failure (the realistic
  case: a DB backup restored into a different config volume than it came from, since the backup
  feature only backs up the database file, not `encryption.key`) is now loud in the server log,
  naming exactly which settings need re-entering, instead of silently going blank.
  **Known follow-up, not done here**: `download_clients`/`indexers` table credential columns
  (separate from the `settings` table) are still plaintext — a larger, separate change.
- **Security headers + configurable CORS**: added `helmet` (CSP and cross-origin-resource-policy
  deliberately left off — this SPA pulls images from arbitrary provider/indexer URLs, and a CSP
  that isn't live-tested against all of them risks silently breaking images rather than meaningfully
  improving security for a single-admin instance). CORS gained an optional `corsAllowedOrigins`
  setting to lock the API down to a specific origin for a split web/server container deployment;
  unset keeps the existing wide-open behavior (low real risk here specifically, since this API is
  header-based, not cookie-based — a cross-origin page can't attach real credentials either way).
- **Dependency vulnerability fixes**: bumped `adm-zip` (0.5.16 → 0.6.1, fixes 2 high-severity
  advisories — DoS and symlink-following arbitrary file overwrite on extraction) and `multer`
  (2.2.0 → 2.4.0, fixes 2 high-severity DoS advisories), plus the transitive `qs`/`body-parser`
  fix via `npm audit fix`. 7 vulnerabilities (5 moderate, 2 high) down to 2 moderate.
  **Known follow-up, not done here**: the remaining 2 moderate findings need a `node-cron` v3→v4
  major-version bump, which risks breaking the scheduler's ~20 registered jobs without live testing
  against the new API — deferred rather than risked blind.
- **Request correlation + HTTP metrics**: every log line produced while handling one HTTP request
  is now tagged with a short correlation id (also echoed back as an `X-Request-Id` response
  header), so a busy log file's lines from one request can be grepped out even when service calls
  are nested many layers deep. The Prometheus `/metrics` endpoint gained HTTP-layer metrics
  (request count, 5xx count, average duration, by method+route) — previously it only had
  business/library gauges (item counts, queue depth), nothing about the HTTP layer's own health.
- **Checked and left alone**: Docker image composition (already genuinely multi-stage with no
  devDependency/build-tool leakage into the runtime image — the noted "bloat" in the earlier
  investigation, a full C toolchain + Python in the runtime image, turned out to be a deliberate
  runtime dependency for ffsubsync/native rebuilds, not something to trim). Accessibility got a
  spot-check (every `<img>` already correctly uses `alt=""` for decorative poster thumbnails next
  to their own title text, real `alt` text where the image IS the content) but a full audit needs
  real tooling (axe-core/Lighthouse) this environment doesn't have — flagged rather than guessed at.

## Round 200 — performance: indexes, FTS5 search, batched bulk edits, bounded search concurrency
- **Database indexes**: the entire schema had exactly two `CREATE INDEX` statements total before
  this round. Added indexes on `media_items(status/monitored/has_file/root_folder_id/sort_title)`,
  `episodes(media_item_id, has_file)`, `sub_items(media_item_id, has_file)`,
  `queue(media_item_id/status)`, `history(media_item_id/created_at)`, and
  `blocklist(media_item_id)` — every one of these backed a routine, frequent lookup (the Library
  page's own filters/sort, the scheduler's monitored-items scan, per-item queue/history/blocklist
  lookups) that was previously a full table scan on any library of meaningful size.
- **FTS5-accelerated library search**: SQLite installs now index every title in the library
  (items, episodes, albums/books/issues/...) in a `library_search_fts` virtual table, kept in sync
  automatically by triggers — no application code needs to know it exists. The existing global
  search endpoint and a brand new **Library page search box** (debounced, SQL-level — searches
  alongside existing sort/filter/pagination, not a separate client-side pass) both use it. A
  leading-wildcard `LIKE '%x%'` scan across three unindexed tables becomes a single indexed MATCH.
  Postgres has no FTS5, so it keeps the original ILIKE query there — existing installs get a
  one-time backfill of the FTS index on first boot after upgrading.
- **Batched bulk-edit queries**: the Library page's bulk monitor/edit/tag actions now issue one
  `UPDATE ... WHERE id IN (...)` (or one multi-row `INSERT`) instead of one query per selected row.
- **Batched duplicate-check counts**: the scheduled duplicate-check job now computes every
  duplicate group's episode/album counts with one grouped query up front (reusing the same
  batching helper the Library page's own child-count column already used), instead of one COUNT
  query per item inside each duplicate group.
- **Bounded-concurrency auto-search**: a show's missing episodes are now searched 3 at a time
  instead of strictly one at a time — real speedup for a show with many missing episodes, while
  staying modest enough not to blow through a configured per-indexer query limit in one burst.
- **De-duplicated search results**: the manual search results table now collapses the same
  release posted to multiple indexers into one row (exact same normalized title + size) instead of
  showing it as several separate results, with a badge listing the other indexers it's also on.

## Round 199 — test notifications, manual-import quality override, import-list review mode
- **"Send test notification" button**: every notification provider tile now has a "Send test
  notification" action, ignoring that provider's own event filter (a test should always go through
  regardless of which events it's configured to care about) — new `sendTestNotification()` and
  `POST /api/settings/notifications/:provider/test`, instead of only finding out a webhook/URL is
  wrong when a real grab/import/failure happens to fire.
- **Manual import quality override**: the Activity page's "Manual import..." picker gained a
  Quality dropdown — Radarr/Sonarr's Interactive Import lets you correct a wrong auto-detected
  quality before confirming; previously AoNarr always trusted whatever `parseReleaseTitle` guessed
  from the release title at grab time, with no way to fix a bad guess.
- **Import List "require review" mode**: a per-list toggle that routes a matched item into the
  existing Import Review queue (previously only used for titles a list couldn't confidently match
  at all) instead of adding it to the library automatically — approve or dismiss each one by hand
  on the Import Review page, reusing its existing two-step "add the normal way, then resolve" flow.
- **Fixed a real bug found along the way**: `POST /api/import-lists` rejected `type: "tmdb"` with a
  400 (an enum check that predated Round 195's TMDB list support and was never updated) — TMDB
  import lists could only ever have been created by hand-editing the database. Now fixed.
- **Bulk "Test all"**: both the Indexers and Download Clients pages gained a "Test all" button
  (sequential, not parallel, so it doesn't blow through a rate-limited indexer's query budget in one
  burst) instead of needing to click each row's test individually.

## Round 198 — freeleech scoring, manual-interaction/update notifications, next-run, min free space
- **Freeleech/halfleech custom-format condition**: the indexer client now captures Torznab's
  `downloadvolumefactor` attribute, and Custom Formats gained a new "indexerFlag" condition type
  (`INDEXERFLAG: freeleech, halfleech` in the text DSL) to score on it — unknown status (an indexer
  that doesn't report it) never matches, so a "must be freeleech" condition correctly excludes it
  rather than treating unknown as satisfying. Manual search results also show a freeleech/halfleech
  badge next to matching releases.
- **"On Manual Interaction Required" notification**: fires when an automatic import gets skipped
  because it couldn't confidently place a file (e.g. an unmatched file in a season pack) — the
  download itself succeeded, it just needs a person to use "Manual import..." on the Activity page,
  distinct from an actual "Failed" event. Previously this was logged only, with no notification.
  Also added "On Update Available", pushed by a new daily job (deduped by round number) instead of
  only ever being visible by loading the System page.
- **Jobs page "Next run"**: computed from each job's cron expression (new `cron-parser` dependency)
  or, for interval-based jobs, estimated from the last run plus the interval — alongside the
  existing "Last run" column.
- **Per-root-folder minimum free space (GB)**: a new setting on each root folder, independent of
  the existing quota-percent warning — a huge drive at 8% free might have hundreds of GB left
  (not urgent), while a small drive at 15% free might have almost none (is). Feeds into both the
  System/Dashboard health check and the scheduled health-issue notification.

## Round 197 — seed-goal cleanup, proactive indexer rate limiting, absolute-number matching
- **Seed goal cleanup**: new opt-in "Seed Goal Cleanup" settings (ratio and/or seed-time goal,
  both blank = disabled) run hourly against every qBittorrent client, removing a torrent from the
  client once it's met its goal — never touches the file AoNarr already imported into the library,
  only frees the client's own queue slot. New `removeSeededTorrents()` on the qBittorrent adapter.
- **Proactive per-indexer rate limiting**: indexers gained a "Query Limit" (requests/hour) field,
  enforced with an in-memory rolling one-hour window before a request is even sent — distinct from
  the existing reactive 429 backoff, which only reacts after an indexer has already rejected one.
  Blank/zero means unlimited (no behavior change for existing indexers).
- **Absolute-episode-number matching for anime**: episodes now store an `absolute_episode_number`
  (running count across real seasons, same convention already used for path naming) and
  `parseReleaseTitle()` detects a bare "Show Title - 145" style number when no SxxExx pattern
  matched. `releaseMatchesEpisode()` accepts it as a last-resort match — anime type only, and only
  ever consulted when a real season/episode pattern didn't already match — so a long-running show
  whose fansub releases carry no season/episode designator at all can still be found and matched.

## Round 196 — Lidarr/Readarr/Youtarr/Whisparr gaps: album types, tag writing, playlists, archive
- **Music album type filtering** (Lidarr): a new `musicAlbumTypes` setting (comma-separated
  album/ep/single/broadcast/other, default `album` — previous hardcoded behavior) controls which
  MusicBrainz release-group types get fetched for an artist, instead of always Album-only.
- **MusicBrainz release selection** (Lidarr): when an album has multiple releases (different
  countries/remasters), track-listing lookup now picks the best one automatically — prefers
  "Official" status, then a broad/major-market release, then the earliest date — instead of
  whatever MusicBrainz's API happened to return first. Automatic, not a manual per-album picker.
- **Audio tag writing / retagging** (Lidarr): new opt-in "Write Audio Tags on Import" setting
  writes artist/album/title/track/year straight into an imported track's ID3v2 tags via the new
  `node-id3` dependency (pure JS, no native bindings). MP3/ID3 only — FLAC/OGG/M4A need their own
  tag formats, not implemented here, and are left untouched.
- **Incomplete series flag** (Readarr): a book's series strip now flags a numbering gap (e.g. have
  #1, #2, #4 — missing #3) with a badge, so a hole in a series is obvious without cross-checking by
  hand. Purely informational; non-integer positions (interstitials/novellas) are excluded from the
  gap check rather than treated as missing slots.
- **YouTube playlist import** (Youtarr): a pasted `youtube.com/...?list=...` URL now works through
  the existing "Match by ID/URL" flow, tracked and re-checked for new videos the same way a whole
  channel already was — `externalIds.youtubePlaylist` alongside the existing `externalIds.youtube`.
- **yt-dlp download archive, SponsorBlock, subtitles** (Youtarr): three new opt-in settings for
  yt-dlp download clients — a persistent `--download-archive` file (never re-download a video
  already grabbed once, even across restarts), `--sponsorblock-remove` categories, and
  `--write-subs --embed-subs` for fetching/burning in captions directly via yt-dlp.
- **Performer/studio tracking** (Whisparr): ThePornDB scene search now also pulls the site name
  (into the existing `studio` field) and a performers list, shown on the media detail page. Stored
  in the item's existing `extra_metadata` scratch field rather than a dedicated performer-entity
  system — no per-performer pages or cross-title filtering, just visible per-title data that wasn't
  captured at all before.

## Round 195 — Sonarr-parity gaps: scene numbering, Monitor options, bulk editor, series stats
- **Scene numbering (TheXEM)**: new `services/sceneNumbering.ts` — for any series/anime with a
  TVDB id, pulls thexem.info's scene-numbering map and stores `scene_season_number`/
  `scene_episode_number` per episode. Search queries now prefer scene numbering when known (what a
  scene-mapped show's releases actually use), and `releaseMatchesEpisode()` accepts either
  numbering as a match (OR, not a replacement — some groups number correctly anyway). Synced
  automatically when a series is added, on a weekly scheduled job, and on demand via a "Sync scene
  numbering" button on the series page. Only covers TVDB-indexed shows — AniList-only anime has no
  TVDB id for thexem to key off, so it has nothing to map (a real, disclosed limitation, not a bug).
- **Monitor options at add time**: Add Media's series/anime flow gained Sonarr's Monitor dropdown
  (All/Future/Missing/Existing/Recent/First Season/Latest Season/Pilot/None) instead of a flat
  monitored on/off — applied server-side right after the fetched episode list is inserted.
- **Add List Exclusions on delete**: deleting a library item (single or bulk) now offers to also
  add it to Import Exclusions, so an active import list doesn't just re-add it on its next sync.
- **Configurable failed-download handling**: Settings gained "Blocklist and search again" (default,
  the existing auto-retry behavior) vs. "Blocklist only" (no automatic retry), plus a configurable
  max-retries count — previously hardcoded at 2 with no toggle.
- **Release-parsing test tool**: the existing "test a release title" box (Custom Formats section)
  now also shows the full parsed breakdown (quality/season/episode/year/group/languages/flags/air
  date) from `parseReleaseTitle()` alongside the custom-format score — the exact same parser every
  real search/match call uses, folded into the existing tool rather than a separate page.
- **Series-level stats**: the episodes summary line on a series/anime page now also shows percent
  complete and total size on disk, not just have/missing/total counts.
- **Unmonitor Deleted Files**: a new nightly check (`services/deletedFileCheck.ts`) now actually
  notices when a file AoNarr had on record is gone from disk — previously nothing did, the DB would
  just keep claiming a deleted file still existed forever. Correcting `has_file` back to 0 always
  happens; a new setting controls whether the item is also unmonitored (off by default).
- **Bulk quality-profile / root-folder editor**: the Library page's multi-select toolbar gained an
  "Apply" action to bulk-change quality profile and/or root folder across a selection — previously
  only possible one at a time, or via the CSV round-trip for quality profile alone (never root
  folder).

## Round 194 — NFO-on-import, log verbosity, certificate validation, media management polish
- **Write NFO on Import** (opt-in, off by default like Radarr's own Kodi/Emby metadata consumer):
  importing a file now optionally writes a same-named Kodi/Jellyfin/Emby `.nfo` sidecar — reuses
  the exact `writeNfoSidecar()` that already runs on manual metadata edits (see Round 192's
  metadataExport.ts), just now also on import for Movies/ROMs/Adult and single-file collection
  types (Books, Comics, Manga, Online Videos, Courses). Series episodes and Music tracks aren't
  covered — per-episode/per-track metadata isn't available at this call site.
- **Colon handling in file names**: `sanitizeForPath()` now turns "Title: Subtitle" into
  "Title - Subtitle" instead of just dropping the colon ("TitleSubtitle") — matches Radarr's own
  default colon-replacement behavior.
- **Skip Free Space Check**: an import is now refused (file stays queued) if it would leave the
  destination filesystem with less free space than the file being placed — a real check before an
  import can run, with a setting to skip it, not a check that already didn't exist.
- **Create Empty Folders** (opt-in): adding a new monitored item can now create its top-level
  library folder immediately via a new `createLibraryFolderSkeleton()`, instead of the folder only
  appearing on first import.
- **Log verbosity control**: Settings/System → Logs gained a "Log verbosity" setting
  (Info/Warn/Error) that controls what's persisted to the in-memory log view and daily log files —
  always still goes to the container's own stdout/stderr regardless. Note: this is coarser than
  Radarr's Trace/Debug granularity, since AoNarr's own logging only ever had info/warn/error levels
  to begin with; this controls how much of *that* gets kept, not a new logging tier.
- **Certificate Validation toggle**: Settings → General gained a Certificate Validation
  Enabled/Disabled setting (default enabled) for an indexer or other configured service running a
  self-signed cert — applies globally to outbound HTTPS requests via the same undici global-
  dispatcher mechanism the SOCKS5 proxy setting already used. Documented limitation: has no effect
  while a SOCKS5 proxy is also configured (the proxy's own connect path doesn't go through this).
- **Corrected a miss from the last gap check**: "Custom Filters" (save/apply/delete a named
  filter+sort+column preset) turns out to already exist — Library pages' "Saved Views"
  (`SavedLibraryView`, `/api/library-views`) is exactly this feature under a different name; the
  prior gap report only checked localStorage persistence and missed the server-side saved-views
  system already wired into the UI.
- **Checked and did NOT build**: UI display preferences (first day of week, date format,
  relative-vs-absolute dates, info/metadata language, color-impaired mode) and a per-multi-episode
  file naming style — real Radarr settings, but cosmetic/low-value for a self-hosted single-user
  instance relative to the effort of adding a whole preferences layer; and a plain HTTP/HTTPS proxy
  option alongside the existing SOCKS5 one — same idea, lower priority than the items above.

## Round 193 — Release Profiles, health notifications, queue blocklist, auth toggle, TMDB lists
- **Release Profiles**: new Radarr/Sonarr-style Settings → Quality section, distinct from Custom
  Formats — plain-text (non-regex) term matching against a release's raw title instead of regex
  condition groups. Must Not Contain rejects a release outright if any term appears; Must Contain
  requires at least one of its terms (empty = no requirement); Preferred terms each add their own
  score (negative downranks) when present. Profiles are AND'd together and can be scoped to
  specific library types the same way Custom Formats are. New `release_profiles` table,
  `services/customFormatScoring.ts`'s `evaluateReleaseProfiles()` folded straight into the existing
  `scoreRelease()` — so every call site (manual search, auto-search, bulk search, retry-after-
  failure) picks it up for free, with `ReleaseScore` gaining `rejected`/`rejectReason` fields that
  now also filter/annotate results everywhere `scoreRelease` is used, including the media detail
  page's manual search results table.
- **Health issue notifications**: Radarr's "On Health Issue" event, fired by a new scheduled job
  (`checkHealthAndNotify`, every 30 minutes) rather than only ever being computed on demand by the
  System page — checks indexer/download-client reachability and low disk space, and notifies once
  per *change* in what's wrong (deduped against the last-notified summary) rather than spamming
  every run. Also added a matching "On Upgrade" event (`notifyUpgraded`), fired instead of the
  existing "On Import" event when an import replaces a file the item already had.
- **Dashboard health banner**: the same checks the System page's health tab computes are now also
  fetched on the Dashboard and shown as a banner at the top when something's wrong — previously an
  admin who wasn't specifically looking at the System page had no ongoing signal at all.
- **Queue "Remove and Blocklist"**: the Activity page's queue now has a combined action instead of
  removing and blocklisting separately across two pages — `DELETE /api/activity/queue/:id?blocklist=1`
  adds a blocklist entry using the queue item's own title/indexer before removing it.
- **Authentication toggle**: Settings → Security gained an "Authentication" setting (Enabled/
  Disabled), Radarr's "Authentication Required" — when disabled every request is treated as an
  authenticated admin, for a trusted private network only.
- **TMDB import lists**: Import Lists gained a "TMDB" type alongside Trakt/IMDb/Last.fm — paste a
  `themoviedb.org/list/<id>` URL or bare numeric list id (needs a TMDB API key set under Settings →
  Metadata). A TMDB list can mix movies and TV shows; each entry's own `media_type` routes it to
  the right library.
- **Checked and did NOT build**: per-indexer tags and a configurable RSS-sync-interval field.
  AoNarr's indexers are queried ad hoc on every search (manual, scheduled auto-search, bulk) — there
  is no RSS-feed-polling pipeline for a "sync interval" to actually control, so a settings field for
  one would be cosmetic. Indexer tags have no consumer either (delay profiles scope by *media item*
  tags, not indexer tags) — adding an unused tag picker would be UI with nothing behind it, the same
  reasoning Round 191 used to skip Remote Path Mappings.

## Round 192 — download client test, rename preview, match by ID/URL, custom posters/backdrops
- **Download Clients**: added a "Test connection" button on the edit form (all types), validating
  credentials/reachability before you rely on it — previously only qBittorrent's post-save "Check
  health" existed, so a wrong host/port/API key on any other client type silently saved with no
  feedback. New `POST /api/download-clients/:id/test`, with a lightweight per-type check (login
  for qBittorrent, version/API-key check for SABnzbd/Real-Debrid/AllDebrid/TorBox/slskd, folder
  existence+writability for Blackhole; http/ytdlp have no external client to test).
- **Rename preview**: "Organize & Rename" (media detail page, Library page, and the per-season
  toolbar) now shows the exact from→to path list in a modal before committing, instead of a blind
  confirm()-then-execute. Backed by a new `?preview=1` dry-run mode on the existing rename routes
  that computes destinations without touching the filesystem or database.
- **Match by ID or URL**: Add Media and the "search for a different match" rematch modal now have
  a "Match by ID / URL" mode alongside title search — paste a TMDB/IMDb/TVDB/AniList/IGDB/RAWG id
  or a straight link from any of those sites' own pages (auto-detected and parsed), or an ISBN for
  the Authors library (best-effort matched to the book's listed author, since ISBN identifies a
  book, not an author). New `GET /api/metadata/match` + `fetchByExternalId()`/`parseProviderUrl()`
  in metadata.ts. Unlike title search, this is a direct id lookup — no fuzzy matching, so it's
  exactly as trustworthy as picking a search result by hand.
- **Custom posters and backdrops**: the Edit Metadata form on the media detail page now has a
  Backdrop URL field (previews inline) alongside the existing Poster URL field — both are plain
  direct-image-URL overrides, saved straight to the item. The Artwork picker's background/banner
  images can now be set as either the backdrop or the poster (previously only "set as poster" was
  offered, even for a wide background image that never fit a poster's aspect ratio well).

## Round 191 — Custom Format tester; Remote Path Mappings deliberately skipped
- Settings → Quality → **Test Custom Formats**: paste a sample release title (+ optional size and
  quality profile) and see which custom formats match and what they'd score — reuses the exact
  `scoreRelease()` function the real search/grab pipeline calls, so results are guaranteed
  accurate rather than a separate reimplementation that could drift. Radarr-parity feature.
- **Did NOT build** Radarr-style Remote Path Mappings, after checking whether it actually applies:
  Radarr needs it because it trusts the file path its download client's API reports and has to
  translate that into its own filesystem view. AoNarr's importer never does that — it always
  scans its own mounted `downloadsDir` directly and matches files by name/title (see
  `importer.ts`'s `findDownloadedFile`/`listDownloadedFileCandidates`), so there's no client-
  reported path to translate in the first place. Building a Remote Path Mappings settings page
  would be a UI with nothing behind it. The actual fix for a split-container setup is making sure
  the download client's completed-download folder and AoNarr's `downloadsDir` are the same mounted
  path — already covered in the Download Clients page's own guidance text.

## Round 190 — closes out the AoNarr-vs-Radarr gap list: updates, size on disk, log files, studio
- **System → Overview** now has an **Updates** check. AoNarr has no numbered releases (rolling
  `main` branch, no git tags/GitHub Releases), so instead of a semver check this compares the
  CHANGELOG "Round N" your build was bundled with against the latest one on GitHub's main branch
  — an honest adaptation of Radarr's Updates page rather than a fake version number.
- **System → Logs** now has a **Log Files** section — persistent daily log files on disk under
  `<config>/logs`, retained 7 days, downloadable individually. The existing "Logs" view is still
  the fast in-memory last-2000-lines view, but it resets on restart; these survive it.
- **Library page**: added a **Size on disk** sort option and column/poster-field, backed by a new
  `size_bytes` column populated at import time (both the single-file and season-pack/album-folder
  import paths). Episodes and sub-items also now record their own `size_bytes` for future use,
  though only the top-level item's size is surfaced in the UI for now.
- **Movies**: added a **Studio** field (TMDB's first-listed production company) — shown on the
  media detail page and available as a Library column/poster-field. Backfilled best-effort during
  Refresh (needs a second by-id TMDB lookup beyond the title-search Refresh already does, since
  TMDB's search results don't include studio).
- **History page** filters (event type / library type / since date) are now remembered across
  visits via localStorage, closing the "no persisted filters outside the Library page" gap —
  Missing/Cutoff Unmet have no filter controls to persist (fixed grouped sections only).
- This closes every gap identified in the last full audit. Two items were explicitly NOT built
  because they'd need to be dishonest to build: a real "install update" button (there's nothing to
  install against — see the Updates note above) and a Radarr-style git-tag version number (AoNarr
  doesn't have one).

## Round 189 — ratings/backdrop/alternate titles for anime, manga, and ROMs
- Extended last round's backdrop/rating/alternate-titles work beyond movies/series to every other
  provider that actually exposes the equivalent data (nothing invented/approximated):
  - **Anime/manga (AniList)**: ★ rating (`averageScore`/10), backdrop (`bannerImage`), and — for
    anime only — runtime (`duration`, per-episode minutes). Alternate titles now include the
    native-script title and AniList's `synonyms` list, for both anime and manga.
  - **ROMs (RAWG/IGDB)**: ★ rating (RAWG's `metacritic` or IGDB's `total_rating`, both normalized
    to the same 0-10 scale as everywhere else) and a backdrop screenshot distinct from the cover
    art already used as the poster.
- Explicitly did NOT add anything for author/artist/comic — audited each provider (Open Library,
  Google Books, MusicBrainz, Deezer, Discogs, Last.fm, Comic Vine) and none exposes a real 0-10
  rating or a distinct backdrop image at the search-result level; inventing a normalization from a
  popularity/fan count wouldn't be a real rating.

## Round 188 — year-assisted metadata search, IMDb/Rotten Tomatoes/Metacritic ratings
- Metadata search (Add Media, and the "Search for a different match" modal on the media detail
  page) now takes an optional **Year** field alongside the title query — results aren't filtered
  out on a mismatch (a provider's year can legitimately be off by one), but an exact year match is
  now sorted to the top, which matters most for remakes, long-running franchises, and generically-
  titled movies/shows ("It", "Dune", "Twins"...) where the title alone is ambiguous. The rematch
  modal now also pre-fills the year field from the item's own current year.
- Media detail page now shows **IMDb / Rotten Tomatoes / Metacritic** badges (via OMDb, needs an
  OMDb API key in Settings and the item to have an IMDb id) alongside the existing TMDB vote-
  average badge — fetched on demand, same pattern as Cast/Alternate Titles, not stored on the item.

## Round 187 — Cutoff Unmet page, global History, Blocklist page, file details, alternate titles
- New **Cutoff Unmet** page (Manage → Cutoff Unmet) — every downloaded item still below its
  quality profile's cutoff, with per-row and bulk "Search" to trigger an upgrade, same layout as
  the existing Missing page. Backed by a new `GET /api/wanted/cutoff-unmet`, reusing the same
  `findUpgradeCandidates()` the System health page's count already used internally.
- New global **History** page (System → History) — every grab/import/failure across the whole
  library, filterable by event type, library type, and a "since" date, instead of only the
  per-item History tab added last round or the unfiltered dashboard Timeline widget.
  `GET /api/activity/history` now accepts `eventType`/`mediaType`/`since` query params.
- New **Blocklist** page (System → Blocklist) — view, remove, or clear every blocklisted release,
  which previously had no UI beyond adding new entries from a search result.
- Media detail page: added a **File details** panel (container path, resolution, video codec, HDR,
  frame rate, bitrate, duration, and full audio/subtitle track tables) behind a toggle button, and
  an **Alternate titles** ("AKA ...") line under the title for movies/series with a TMDB id — both
  new, on-demand, TMDB-only for now (mirrors the existing Cast/Trailer lookup pattern via a new
  `GET /media/:id/alternate-titles`).

## Round 186 — Cutoff Unmet filter, media detail backdrop/ratings/history
- Added **Cutoff unmet** to the library status filter, alongside Missing/Downloaded/etc — flags
  every downloaded item whose current quality ranks below its own quality profile's cutoff (the
  same rank comparison search/grab decisions already use), so upgrade candidates are one filter
  click away instead of needing the System → Upgrade Candidates report.
- The media detail page now shows a full-bleed backdrop/fanart image behind the poster and title
  block, Radarr-style, plus a ★ rating badge (TMDB's vote average) and runtime (minutes) next to
  the year/type/status line — new `backdropUrl`/`rating`/`runtimeMinutes` fields on media items,
  populated from TMDB on add, rematch, and Refresh (movies and series only for now; other
  providers/types don't expose this data).
- Added a **History** tab to the media detail page's action row — every grab/import/failure event
  recorded against that specific item, newest first (reuses the same `history` table the global
  Activity page already reads from). Failures are now actually written to history, not just the
  blocklist, so this tab isn't empty for anything that's ever failed.
- Scope note: this covers the most visible pieces of Radarr's movie-page layout, not a full port —
  no Rotten Tomatoes/separate-IMDb scores (only TMDB's own vote average), and ratings/runtime only
  backfill for movie/series/anime since that's what TMDB search returns.

## Round 185 — Radarr-style library view: status banner, Overview view, more sort/field options
- Every poster now carries a Radarr-style colored status strip along its bottom edge — green
  "Downloaded", red "Missing", grey "Unmonitored", or blue "Unreleased" (release date still in the
  future) — so a poster grid reads at a glance without hunting through the info line underneath.
- Added a third view mode, **Overview**, between Posters and Table: a compact row per item with a
  small poster thumbnail, title, status badge, and the same toggleable info fields as the poster
  view — mirrors Radarr's own "Overview" library view. The old "List" view is now labeled "Table"
  to match Radarr's naming for the same thing.
- Added **Release date** and **Path** to both the sort dropdown and the poster/overview info-field
  and table-column pickers, alongside the existing Year/Status/Monitored/Quality/Content
  rating/Added.

## Round 184 — add TorBox as a download client
- **TorBox** joins Real-Debrid/AllDebrid as a supported debrid-style download client — grabbed
  magnet/torrent links are sent to TorBox's API, AoNarr waits for it to cache them, then downloads
  the resulting file(s) directly into `/downloads` the same way the other two debrid clients do.
  Just an API key needed (Settings → Download Clients → Add → TorBox), no host/port.
- Usenet isn't wired up for it yet (only the torrent/magnet side), so it's only offered to
  torrent-protocol grabs, same as Real-Debrid/AllDebrid.

## Round 183 — fix the same event-loop-blocking file copy in the normal import path
- Round 182 fixed `recycleFile()` blocking the whole server on a large cross-device file copy
  during a Duplicates merge. The same `fs.copyFileSync` pattern was also in `importer.ts`'s own
  `moveFile()` — used by every normal download import, season-pack/album import, and Organize &
  Rename — so a large file landing on a different Docker mount than its destination (e.g.
  `/downloads` vs `/media`) could freeze the entire server for everyone during a completely
  ordinary import, not just a merge. Switched to the same `fs.promises`-based async copy; cheap
  metadata operations (mkdir/rename-within-a-filesystem/chmod/chown/symlink/hardlink) are left as
  the synchronous calls they already were, since only the actual file-content copy was ever the
  blocking part.

## Round 182 — fix Duplicates merge 502 (server hang, not a crash)
- **Root cause**: merging duplicates with "delete files" recycles the loser's file via
  `recycleFile()`, which — when the recycle bin and the media library live on separate Docker
  mounts (`/config` vs `/media`, a very common setup) — fell back to `fs.copyFileSync`. That call
  blocks Node's single-threaded event loop for the *entire* duration of the copy: for a multi-GB
  file, the whole server (every request, from every user, including nginx's own health check)
  simply stopped responding until the copy finished. From outside, that looked like a bare 502 with
  nothing in the logs, since nothing ever actually threw an error. `recycleFile` now uses the same
  non-blocking `fs.promises`-based move the recycle-bin *restore* path already used (it had this
  exact fix; the recycle-*to* path just never got it).
- **Added `uncaughtException`/`unhandledRejection` process handlers** (there were none at all).
  Without them, any stray error outside Express's own request handling silently kills the whole
  container (combined/entrypoint.sh restarts it when node dies) — and since the in-app Logs page is
  just an in-memory buffer, a restart wipes it clean, which is the other reason "nothing showed in
  the logs." Now logged and the server keeps running instead of disappearing along with the evidence.
- Bumped nginx's `/api/` proxy timeouts from the 60s default to 300s, so a genuinely slow (but
  alive) operation surfaces as a real timeout instead of an ambiguous connection drop.

## Round 181 — fix per-item Scan & Import skipping everything
- **Root cause**: Round 175 made `titlesMatch()` exact-only to stop Scan & Import merging two
  different shows together (see that round's notes). That was correct for deciding which existing
  show a file belongs to — but the per-item/per-season "Scan & Import" buttons also used the same
  exact match just to decide "is this file even for the show this button is on," comparing the
  filename/folder-guessed title against the show's real metadata title. Those routinely differ
  (a folder named "The Office" vs. a matched title of "The Office (US)", missing subtitles,
  punctuation) — once that comparison became exact-only, a mismatch meant the button silently
  skipped every single file, reported as "matched 0, created 0, skipped N" with nothing in the
  container logs explaining why.
- Restored the old, lenient (substring-inclusive) comparison specifically for that "is this file
  plausibly for this show" gate — safe to do because the button already knows its target by id;
  it can't misroute a file to a *different* existing show, since that decision still goes through
  the strict, exact match. Full-library scans (where the cross-show-merge bug actually happened)
  are unaffected — they never set this filter at all.
- The per-item and per-season Scan & Import routes now log their result (matched/created/skipped +
  per-file skip reasons) to the container logs the same way the whole-library scan already does,
  and the result popup itself now lists the first few skip reasons directly instead of just bare
  counts.

## Round 180 — fix the UI appearing not to update after a container update
- **Root cause found**: nginx sent no `Cache-Control` header at all on `index.html`, so a browser
  could keep serving its own cached copy of the OLD `index.html` — which references the OLD
  hashed JS bundle filename — indefinitely after pulling a new image. This is why recent UI
  changes (manual import, scroll restore, etc.) could look like they never landed even though the
  container itself was fully up to date. Verified by pulling `allornothing/aonarr:combined` fresh
  from Docker Hub and confirming the built JS bundle already had the changes — the deploy was
  correct, the browser just never asked for it again.
- `index.html` (and `sw.js`) now get `Cache-Control: no-cache` (always revalidated, cheap via a
  304 when unchanged); the Vite-built, content-hashed files under `/assets/` get
  `Cache-Control: public, max-age=31536000, immutable` (safe to cache forever — a new build always
  gets a new filename). Applies to both the combined image's nginx config and the split web
  image's.
- Bumped the PWA service worker's cache name so an already-registered service worker picks up a
  real update instead of being byte-identical to what's already installed.
- **If you already hit this**: after updating to this round, do one hard refresh (Ctrl+Shift+R, or
  clear the tab's cached data) once — the header fix prevents *future* staleness, it can't evict
  what a browser already cached before this fix existed.

## Round 179 — season-scoped actions, season artwork + tile view
- **Season toolbar now has Scan & Import, Manual Import, Organize & Rename, and Refresh**, next to
  the existing Search season/Monitor/Unmonitor — each scoped to just that season instead of the
  whole show. Scan & Import skips any file that doesn't parse to that season; Manual Import opens
  the file browser with only that season's episodes offered as targets; Organize & Rename only
  touches that season's already-imported files; Refresh re-syncs that season's episode
  titles/air dates/artwork without touching the show's own title/overview/poster.
- **Season artwork.** A new `seasons` table stores a per-season poster URL, populated from TMDB
  (whose show-detail response already carries each season's poster — no new API surface, just a
  field that was being read past before). Refresh (whole-show or season-scoped) fetches and stores
  it.
- **List/Tiles toggle on the Episodes section** — Tiles shows a poster grid, one tile per season
  (season artwork with a show-poster fallback, plus a downloaded-count), reusing the same grid/card
  styling as the Library page's poster view. Clicking a tile switches back to List with that season
  expanded and scrolled into view.

## Round 178 — Media Analyzer: clickable stat rows, spoken-language table
- **Every stat table on Media Analyzer (video codec, HDR format, audio codec, resolution, subtitle
  languages) is now clickable.** Clicking a row (e.g. "h264") filters the files table below down to
  just the files with that value — click it again to clear. Composes with the existing
  caution/incompatible filter, so both can narrow the list at once.
- **Added a "Spoken languages" table**, same shape and same clickable behavior as the existing
  "Subtitle languages" table, but for audio track languages — the data (`audioStreams[].language`)
  was already captured by ffprobe and stored, it just wasn't being aggregated or shown anywhere.

## Round 177 — more naming tokens: episode title, show year, quality
- **New naming tokens, Sonarr/Radarr-parity:** `{episodeTitle}` and `{year}` (the show's year) for
  TV Shows/Anime, and `{quality}` for every library type (Movies, TV Shows/Anime, and every
  collection type — Music, Books, Audiobooks, Comics, Manga, Online Videos, Podcasts, Courses).
  All three were already sitting right there in the database at rename time — episode
  title/air date were fetched but never added to the template's variables, and quality was passed
  around for other purposes but never threaded into the renderer. Wired into every place a file
  gets placed or renamed: import, season-pack import, album import, and Organize & Rename/Rename
  Files (both per-item and library-wide).
- **Default TV Shows/Anime naming template now includes the episode title** —
  `{parentTitle} - S{season:00}E{episode:00} - {episodeTitle}`, matching Sonarr's own default.
  Anyone with a custom template override is unaffected; anyone still on the default picks this up
  the next time they import or click Organize & Rename.
- All three new tokens are listed in the naming template picker (Settings → Naming) with live
  preview support, same as every existing token.

## Round 176 — multi-file manual import, library A-Z jump, scroll restore, episode metadata fix
- **Manual Import now imports several files at once, Sonarr-style.** The Manual Import panel (on a
  show/collection item, in the season table, and now on the individual episode page too) lists
  every browsed file with a checkbox and its own target episode/child — episodes are auto-matched
  from the filename (SxxEyy/1x01) where possible — and one "Import checked files" click sends them
  all in a single batch (`POST /import/manual-batch`), reporting per-file success/failure instead of
  requiring one click per file.
- **Manual Import button added next to Search** on each episode row in the season table and on each
  sub-item row (Albums/Books/Lessons/etc. — every collection-shaped library type shares that one
  table, so this covers Music, Books, Audiobooks, Comics, Manga, Online Videos, Podcasts, and
  Courses too), plus on the standalone episode detail page.
- **A-Z jump sidebar on every library page**, shown whenever the library is sorted by Title —
  click a letter to jump straight to it, even across pages.
- **Library list remembers your scroll position.** Hitting the browser Back button from a show's
  page used to always land back at the top of the library list; it now restores exactly where you
  were scrolled to.
- **Fixed: Scan & Import-created episodes never got their real title/air date.** A newly scanned
  episode with no matching placeholder row used to get a hardcoded "Episode N" title and a null air
  date forever — nothing ever revisited it, even after the show was later matched to real metadata.
  Scan & Import now looks the show up on its metadata provider right away and seeds real episode
  titles/air dates/overviews from the start, and Refresh now backfills any already-existing
  placeholder episode's title/air date too instead of only inserting ones that don't exist yet.

## Round 175 — fix Scan & Import merging unrelated shows, add a Split button
- **Scan & Import no longer merges two different shows (or movies/albums) into one.** `titlesMatch()`
  used to treat one title as a match for another if either was a substring of the other — so e.g.
  a show whose guessed title was `"Extraction"` would match one guessed as `"Extraction 2"`, and
  two shows in two completely separate folders would collapse into a single series with the second
  folder's episodes just tacked onto the first. Matching is now exact (after the same normalization)
  only.
- **Split button on TV show pages.** For shows that already got incorrectly merged by the old
  matching bug (or any other reason), a new "Split..." button on the show's detail page lets you
  check which episodes actually belong to a different show — grouped by their on-disk folder as a
  guide — and move them into a brand new show with its own title. Nothing on disk is touched, only
  which show each episode's row belongs to.

## Round 174 — real PUID/PGID support
- **PUID/PGID now actually do something.** Both the `combined` and `server` images previously
  shipped a `PUID`/`PGID` env-var pair in `docker-compose.yml` that did nothing — the container
  always ran as root. The entrypoint now creates a matching user/group on startup, chowns
  `/config` to it (only when ownership doesn't already match, so restarts are cheap), and runs
  the node process as that user via `gosu`. nginx (in the `combined` image) keeps running as
  root since it only serves the built-in web bundle and proxies to node — it never touches
  user-owned volumes. Defaults are `99`/`100` (Unraid's `nobody`/`users`).

## Round 173 — #13's remaining items, root folder delete-cascade, root folder move
- **Per-track music filename templating** (closes the rest of #13) — Music's individual track
  filenames were always kept exactly as downloaded; only the album folder was templated. New
  `namingArtistTrackTemplate` setting (Settings → Media Management → Naming), tokens
  `{trackNumber}`/`{trackTitle}`/`{parentTitle}`/`{childTitle}` — applies once a file is matched
  to a known track number (an unmatched file keeps its original name, same as naming disabled),
  respects the same enable/disable toggle Music's album-folder naming already has.
- **Plex sign-in instead of pasting a token** (closes the rest of #13) — implemented Plex's real
  PIN-based sign-in flow (`plex.tv/api/v2/pins`) instead of asking an admin to dig a token out of
  Plex's own XML API responses (which are frequently temporary/session-scoped). "Sign in with
  Plex..." opens plex.tv in a new tab; once signed in there, a real, durable third-party token is
  saved automatically — no separate copy/paste step.
- **Remove media items when their root folder is removed** (opt-in) — deleting a root folder
  previously always just silently orphaned every media item that was in it (`root_folder_id` set
  null via the FK, item otherwise untouched and still fully in the library) with no way to
  actually remove them along with the folder. `DELETE /api/root-folders/:id?deleteMedia=1`
  (optionally `&deleteFiles=1` to also recycle their files) now offers that as an explicit choice;
  default behavior is unchanged. Reuses the exact same cascade logic the single-item delete route
  already had, extracted into a shared `deleteMediaItemCascade()` rather than duplicated.
- **Move a root folder's files to another root folder** (Sonarr/Radarr-style) — previously the
  only way to change a media item's root folder was a raw `PATCH` that repointed the DB column
  without moving anything on disk, silently desyncing `root_folder_id` from where the file
  actually lives. New "Move all files to another root folder" action (same media type only)
  physically relocates every item — reuses the existing `renameOneMediaItem()` almost entirely
  unchanged (it already recomputes an item's destination from its *current* `root_folder_id` and
  moves the file if that differs from where it is now, so updating `root_folder_id` first and
  calling it is the entire "move" operation) plus a small added cleanup pass for the old root
  folder's now-empty leftover directories, which `renameOneMediaItem`'s own cleanup can't reach
  since it's scoped to the item's new location. Fire-and-forget, like every other whole-library
  operation here.
- Verified live end-to-end: ran the real per-track templating against fabricated album files and
  confirmed both the renamed files and their `tracks.file_path` rows landed correctly; created a
  real PIN against Plex's actual API and confirmed both the create and poll-status routes work
  against it; moved a real file between two root folders and confirmed it physically relocated,
  `path` updated, and the source folder's now-empty subdirectory was cleaned up; confirmed
  deleting a root folder without `deleteMedia` preserves existing orphan-only behavior, and with
  it removes the item entirely.

## Round 172 — GitHub issue fixes: #11, #12, #13, #14, #15, #16
- **#12 — Root folder never auto-selected on search-based import or request approval**
  (confirmed, root cause already correctly identified by the reporter). `routes/media.ts`'s
  manual `POST /media` already called `autoSelectRootFolderId()`; `routes/metadata.ts`'s
  `POST /import` (the normal add-from-search flow) and `routes/requests.ts`'s
  `approveRequestRow` (used by both admin approval and auto-approval) did not, silently leaving
  `rootFolderId` null with exactly one root folder configured — the case a household request
  portal user has no way to work around at all, since restricted accounts never see a root
  folder selector. Both now call the same fallback.
- **#11 — Blocklist buried under Quality settings, no "clear all"** — moved the Blocklist tile
  from Settings → Quality into Settings → Media Management, and added a `DELETE /api/blocklist`
  endpoint + "Clear all" button (confirmation-gated) instead of only one-by-one removal.
- **#14 — Future-dated episodes searched before they've aired** — the scheduled auto-search's
  episodic branch only skipped daily-type episodes with an unknown air date; a future-dated
  *known* air date (the reported case) had no gate at all, so it searched anyway and returned
  noise — unrelated titles that happen to match the query, sometimes grabbed as false positives.
  Now skips any episode whose air date is still in the future, regardless of series type.
- **#15 — Manually removing a file from disk leaves the item stuck "downloaded"** — AoNarr
  already had the right mechanism for this (the weekly corrupt-media check treats "file missing
  from disk" as a validation failure and resets state), but nothing let a user trigger that
  immediately after removing a file themselves rather than waiting up to a week. Added a "Mark
  as missing" button to the Episode and sub-item (book/comic/audiobook/etc.) detail pages —
  resets `hasFile`/`filePath`/`quality` in one call, the same state a never-downloaded item is
  in, so it's picked back up by auto-search right away. Also closed a gap the fix surfaced: the
  episodes and sub-items `PATCH` routes accepted `hasFile`/`filePath` but not `quality`, so
  quality was never actually being cleared on a reset.
- **#16 — Search results shown in whatever raw order the indexer returned, not by relevance**
  — the manual search view already computed `matchesTarget`/`allowedByProfile`/`formatScore`
  annotations per result but never used them to *order* the list, so an unrelated release that
  merely shares a word in its title (the reporter's example: a completely different show
  outranking the actual target because the indexer's own search returned it first) could sit at
  the top. Now sorted by the same signals an automatic grab already weighs: real match first,
  then profile-allowed, not blocklisted, format score, then seeders — the top result is now what
  auto-search would actually pick, not just whatever the indexer happened to return first.
- **#13 (partial)** — three of four items:
  - **Form focus jumping back to the first field on every keystroke** (root cause found): the
    shared `Modal` component's focus-management `useEffect` depended on `[onClose]`, and callers
    almost always pass `onClose` as an inline arrow function — a brand-new function identity on
    every parent re-render, which typing into any controlled field inside the modal triggers.
    The effect re-ran on every keystroke and explicitly refocused the first field each time.
    Split into two effects: one-time focus-on-mount (empty deps, runs once) and a separate
    keydown-listener effect that can safely depend on `onClose` without touching focus. Fixes
    every form built on `Modal` at once, not just the one form the report happened to name.
  - **"No way to discover an existing, already-organized library"** — this already existed
    (`scanAndImportAllLibraries`, the "Library Scan & Import" scheduled job) but had no visible
    trigger anywhere outside the generic Jobs page, which doesn't read as "scan my library" to
    someone looking for it. Added a clearly-labeled "Scan library for existing files" button to
    System → Maintenance, right where "Scan for orphaned files" (a related but different
    diagnostic-only action) already lives.
  - Music's incomplete per-file naming scheme (directories templated, individual track filenames
    always kept as-downloaded) and Plex OAuth login (vs. pasting a token) are real, larger asks
    left for a dedicated round — the former is a deliberate existing architectural choice noted
    in `importer.ts`'s own comments (retemplating per-track filenames on rename is a materially
    riskier operation than per-item file rename), not a quick fix.
- Verified live end-to-end for every item: confirmed both `POST /metadata/import` and request
  approval now auto-select the root folder with exactly one configured (root cause scenario from
  #12, reproduced exactly); confirmed the blocklist clear-all endpoint empties a real 2-entry
  list in one call and the tile renders under Media Management; confirmed the sort comparator
  against the reporter's own exact scenario (an unrelated "Bear Grylls" result no longer
  outranks the real "The Bear" match); confirmed a `PATCH` reset via the real API round-trips
  `hasFile`/`filePath`/`quality` back to null; and reproduced the focus bug's exact repro steps
  in a real browser (typed a full IP address into a download client's Host field character by
  character) — focus stayed on the field the entire time instead of jumping back to Name.

## Round 171 — IRC instant-grab announce feeds
- **IRC Announce Feeds** (new page, Configuration → "IRC Announce Feeds") — Autobrr's core idea:
  monitor a private tracker's announce channel over IRC in real time so a release can be grabbed
  within seconds of being posted, instead of waiting up to `searchIntervalMinutes` for the next
  scheduled poll. Deliberately matched against AoNarr's own monitored-item model rather than
  autobrr's "blind filter" firehose — an announce only ever results in a grab if it matches
  something already monitored and missing, using the exact same title/episode matching and
  quality-profile + custom-format scoring the scheduled search already uses. Nothing is grabbed
  just because a message matched a regex; the same "does anyone actually want this" gate every
  other grab path already enforces, just reacting far faster.
- Implemented as a hand-rolled minimal IRC client directly on Node's `net`/`tls` sockets (same
  reasoning as the SMTP client elsewhere in this codebase — IRC is a small, well-specified,
  line-based text protocol, and this only ever needs to sit in one channel and read announces) —
  registration, optional SASL PLAIN auth, PING/PONG keepalive, and reconnect-with-backoff. No new
  dependency. `announceRegex` is admin-configured per feed with named capture groups `title`/`url`
  — parsing an announce line is inherently tracker-specific, so this is left configurable rather
  than AoNarr shipping per-tracker definitions the way autobrr does for hundreds of sites.
  Reconnects live (no restart needed) whenever a feed is added/edited/removed/toggled.
- `grab()`, `isAlreadyQueued()`, and `pickClientForProtocol()` exported from `scheduler.ts` for
  reuse — an IRC-triggered grab is the exact same operation a scheduled-search grab is, just
  triggered by a different event; `guessTitleFromText`/`titlesMatch`/`normalizeForMatch` exported
  from `libraryScan.ts` for the same reason (title-matching an announce against the library is the
  same fuzzy-match problem the disk-scan importer already solved).
- Verified live end-to-end against a real IRC connection (a minimal fake IRC daemon written for
  this test, run as a real TCP server — not mocked in-process): confirmed AoNarr's IRC client
  actually connects and completes registration, injected a real PRIVMSG announce for a title
  matching a real monitored-and-missing test movie, and confirmed it was instantly grabbed — the
  exact magnet URI from the announce landed in a Blackhole download client's watch folder with the
  correctly-derived filename, and the queue/history rows were created correctly.

## Round 170 — Discord `/request` slash command
- **Discord Requests** (Settings → General → "Discord Requests") — a `/request` slash command
  (Doplarr's core idea) letting anyone in a Discord server add a movie or TV show straight from
  chat: `/request type:Movie title:...` searches metadata, checks for an existing duplicate, and
  adds it to AoNarr on a match. Built as an HTTP Interactions Endpoint (Discord POSTs the
  interaction to a URL you register, no persistent Gateway/WebSocket connection or `discord.js`
  dependency needed) — a much better fit for AoNarr's existing REST-server architecture than a
  always-connected bot process would be.
- Signature verification uses Node's *native* Ed25519 support (`crypto.sign`/`crypto.verify`,
  available since Node 12) — Discord distributes its public key as a raw 32-byte hex string, which
  just needs the standard fixed 12-byte SPKI DER prefix prepended before `crypto.createPublicKey`
  will accept it. No new dependency for something every from-scratch (non-`discord.js`)
  interactions endpoint has to solve. `app.ts`'s global `express.json()` now also stashes the
  literal raw request bytes on `req.rawBody` (a `verify` callback) — signature verification is
  over Discord's exact original bytes, which re-serializing the parsed JSON object wouldn't
  reliably reproduce byte-for-byte.
- Handles Discord's 3-second interaction timeout with the standard deferred-response pattern:
  immediately acknowledges (type 5, "thinking..."), then does the actual metadata search/add in
  the background and edits the response in via Discord's webhook-message-edit endpoint once ready
  — a search plus (for a series) episode population can easily run past 3 seconds.
- Verified live against the real running server with a real generated Ed25519 keypair: confirmed
  a validly-signed PING interaction gets a correct PONG (200), confirmed both an invalid signature
  and missing signature headers are rejected (401), and confirmed a real `/request` slash-command
  payload dispatches all the way through — deferred ack, background handler invoked, real metadata
  search attempted — failing gracefully with a clear message when TMDB isn't configured (no live
  TMDB key available in this dev environment).

## Round 169 — Watch-history-based recommendations + auto-request
- **"Because you watched X"** — the Recommendations page already suggested titles similar to
  what's already in the library ("because you added X"); it now also suggests based on actual
  watch history from the configured media server, a real interest signal "was it added" alone
  doesn't carry. Both bases run side by side and are labeled distinctly on the page.
- **Auto-Request from Watch History** (Settings → Media Management, opt-in, disabled by default)
  — SuggestArr's real distinguishing move: close the loop and automatically add the top few
  watch-history-based suggestions every run (new scheduled job, daily by default) instead of
  requiring someone to browse and click "Add." Deliberately only ever acts on the watch-history
  basis, never "because you added X" — what's in the library says nothing about whether anyone
  wanted it, while what was actually watched does.
- `recommendations.ts` refactored so `recommendMovies`/`recommendSeries` take their source items
  as a parameter (recently-added or recently-watched) instead of hardcoding the added-only path —
  one TMDB-similarity implementation serves both bases, not two.
- Verified live: confirmed `GET /api/recommendations` still dispatches correctly after the
  refactor (empty arrays, since this dev instance has no TMDB key or media server configured —
  the same gates the feature itself relies on), confirmed the new settings round-trip, and ran
  `runAutoRequestFromWatchHistory()` directly to confirm it no-ops cleanly with zero candidates
  rather than erroring.

## Round 168 — "Leaving Soon" archival preview
- **Leaving Soon** (System → Maintenance) — Maintainerr's headline UX idea: a preview of exactly
  what the next scheduled auto-archival run will sweep up, computed with the same eligibility
  logic `runAutoArchival` already used (watched + past its effective retention window, honoring
  tag/collection retention overrides) but nothing actually touched. AoNarr's archival already had
  real substance Maintainerr's simpler competitors lack (per-tag/per-collection retention
  overrides, a recycle-bin safety net) — the actual gap was visibility: nothing showed what was
  coming before it happened. The scheduled date recalculates live from the media server's current
  watch status on every load, so rewatching something pushes it down the list automatically —
  no separate "reset the timer" logic needed, since there's no separate timer to reset.
- Refactored the eligibility-finding logic in `archival.ts` into a shared, read-only
  `getUpcomingArchivals()` used by the new preview endpoint, alongside the existing mutating
  `runAutoArchival()` — same conditions, no duplicated logic.
- Verified live: confirmed `GET /api/system/archival/upcoming` returns cleanly (correctly empty,
  since this dev instance has no media server configured — the same early-exit `runAutoArchival`
  itself already relies on) and confirmed the Maintenance tab's new "Leaving Soon" section loads
  and renders the empty state correctly end-to-end through the real UI.

## Round 167 — Multi-language subtitles + background rescan
- **Simultaneous multi-language subtitle downloads** — AoNarr's subtitle provider setting already
  accepted a comma-separated language list, but the download logic only ever picked one overall
  "best" result across every language mixed together, silently dropping every language but one.
  Now downloads one subtitle per configured language, each as its own language-coded sidecar file
  (`Movie.en.srt`, `Movie.fr.srt`, ...) — matching what the setting already implied it did.
- **Background subtitle rescan** (new scheduled job, daily by default) — previously a subtitle was
  only ever fetched once, at import time; a provider added later, a language added to an existing
  provider config, or a transient search failure meant that file just never got a subtitle, ever.
  The new job re-checks every downloaded video (movies/ROMs/adult, series/anime episodes — the
  same scope the at-import fetch already covers) against every configured language and fills in
  whatever's still missing. Idempotent by design — safe to run against the whole library on a
  schedule without re-fetching anything already on disk.
- Both share one new `downloadSubtitleForLanguage()` function in `importer.ts` (exported, reused
  by the new `subtitleRescan.ts` job) rather than duplicating the search/download/sync logic.
- Verified live with a mock subtitle provider server: confirmed both English and French subtitles
  download as distinct sidecar files with correct per-language content, confirmed the rescan job
  makes zero server requests when a video is already fully covered, and confirmed deleting one
  language's subtitle and re-running the rescan restores exactly that one language (2 requests)
  without touching the other, already-present one.

## Round 166 — Overseerr/Jellyseerr webhook integration
- **Overseerr / Jellyseerr webhook** (Settings → Media Management → "Overseerr / Jellyseerr") —
  DUMB bundles Seerr (Overseerr/Jellyseerr) as the request-UI layer in front of Sonarr/Radarr;
  AoNarr already has its own built-in Requests page, but plenty of setups already run Overseerr
  or Jellyseerr as a nicer-UX family-facing request tool and want it to feed a real backend on
  approval — same idea as pointing it at Radarr/Sonarr, except AoNarr isn't API-compatible with
  either, so this is a webhook receiver instead of a Radarr/Sonarr-shaped connection. Point
  Overseerr/Jellyseerr's own webhook notification setting at the generated, token-gated URL; an
  approved request (`MEDIA_APPROVED`/`MEDIA_AUTO_APPROVED`) is resolved by TMDB id straight to
  AoNarr's library (movie or full series with episodes) and picked up by auto-search like anything
  else. Every other notification type (test, media-available, issue-reported, etc.) is
  acknowledged and ignored. Mirrors the existing Plex/Jellyfin/Emby webhook's exact pattern: a
  dedicated `?token=` (can't set custom headers from Overseerr's own config), exempted from
  `requireAuth`, always responds 200 once the token checks out so an ignored-but-legitimate event
  doesn't look like a delivery failure and get retried.
- New `fetchMovieByTmdbId`/`fetchSeriesByTmdbId` direct-lookup-by-id functions in `metadata.ts` —
  every existing TMDB function was search-by-title; a webhook hands over a TMDB id directly, with
  nothing to search for.
- Verified live: generated a real webhook token via the admin route, confirmed the public endpoint
  rejects a request with no/wrong token (401), confirmed a `TEST_NOTIFICATION` payload (what
  Overseerr's own "Test" button sends) is correctly ignored, and confirmed a real
  `MEDIA_APPROVED` payload dispatches all the way through — notification type accepted, media
  type parsed, tmdbId extracted, dedupe check passed — failing gracefully with a clear, actionable
  message when TMDB isn't configured (no live TMDB key available in this dev environment).

## Round 165 — Import strategy (hardlink/symlink) + live CPU/memory metrics
- **Import Strategy** (Settings → Media Management) — two gaps found studying dumbarr.com (DUMB),
  a Docker stack orchestrator heavily built around debrid workflows (Riven, Zurg, Decypharr).
  AoNarr's file placement only ever moved or copied a file; now configurable to **Move** (default,
  unchanged), **Hardlink** (Sonarr/Radarr's real "Use Hard links instead of Copy" — the library
  file and the still-seeding torrent file share the same disk data, falling back to a
  non-deleting copy across filesystems since a cross-device hardlink is impossible and deleting a
  seeding source would break seeding), or **Symlink** (what actually makes a debrid/rclone-mounted
  setup usable — the "download" is a remote-mounted virtual file, and the library entry just
  points at it instead of physically copying a multi-GB file that was never local to begin with).
  Every import/rename path already funneled through one `moveFile()` helper in `importer.ts`
  (same insertion point Round 158's File Permissions used), so this needed no changes anywhere
  else. Symlinks are deliberately never chmod'd/chown'd — that would touch the pointed-to file,
  usually a read-only remote mount this container has no business modifying.
- **Live CPU/memory metrics** (System → Overview) — DUMB's dashboard surfaces live CPU/RAM/disk
  usage; AoNarr already tracked disk usage/forecast but had nothing for CPU/RAM. New
  `GET /api/system/resources` (real `os.loadavg()`/`os.totalmem()`/`os.freemem()`, no DB writes)
  polled by the web UI every 5s — deliberately a separate, cheap endpoint from the existing
  `/system/status` (which also writes disk-usage samples and statfs's every root folder), so
  the "live" feel doesn't come at the cost of hammering those heavier paths on a timer.
- Verified live: ran the real `placeFile()` import pipeline for all three strategies inside the
  actual running container and confirmed via `fs.lstatSync` — move deletes the source (nlink 1),
  hardlink shares the same inode with the source intact (nlink 2), symlink is a real symlink with
  the source untouched — and confirmed `/api/system/resources` returns real, changing load-average
  and memory numbers matching the container's actual `/proc` stats.

## Round 164 — Self-service invite links for household users
- **Invite Links** (Users page → "Invite Links") — Wizarr's core idea, scoped to AoNarr's own
  household accounts rather than a cross-server orchestrator. Previously every household user had
  to be created by an admin typing in their username and password directly; now an admin
  pre-configures the library access, max content rating, role, and optional expiry, generates a
  one-time `/invite/:token` link, and shares it — the recipient opens it (no login required) and
  picks their own username/password. Landing on the link logs them straight in with exactly the
  access the admin configured.
- New `user_invites` table; the accept page (`InviteAcceptPage.tsx`) is a fully public top-level
  route mounted outside the app's login gate (`ApiKeyGate`) in `main.tsx`, mirroring how
  `SharePage.tsx` already handles public unauthenticated links — same pattern, new use.
  `/api/invite/:token` (GET preview, POST redeem) is exempted from `requireAuth` the same way
  OPDS/calendar/share links already are; `/api/users/invites` (admin management: create/list/
  revoke) stays behind the normal admin gate.
- Verified live end-to-end against both SQLite and a real Postgres container (schema migration
  applies cleanly to both): created a real invite via the admin route, redeemed it as a fully
  unauthenticated request confirming the public preview and account-creation endpoints both work
  with no credentials, and confirmed in the browser that the resulting session lands the new user
  in the app with exactly the two libraries granted (Movies, TV Shows) and no admin-only pages
  visible — the scoping actually took effect, not just the account row.

## Round 163 — MCP server (AI agent control)
- **MCP server** at `POST /api/mcp` (Settings → General shows the endpoint URL) — lets Claude or
  any other MCP-speaking agent drive AoNarr directly: search the library, search metadata
  providers, add/delete media, toggle monitored, search indexers for releases, grab a release,
  check the queue, check system health, and read/write settings. Chosen scope is "full control"
  — every tool is a thin proxy onto AoNarr's own REST API (loopback, authenticated with the same
  instance API key any script already uses), so an MCP client can do anything that key already
  grants. No separate token or auth path: `/api/mcp` sits behind the same `requireAuth` gate as
  every other `/api` route.
- Built on the official `@modelcontextprotocol/sdk` (stateless Streamable HTTP transport — a
  fresh `McpServer` + transport per request, since every tool is already a stateless REST proxy
  with nothing to hold open between calls) plus `zod` for input schemas, both new dependencies.
  14 tools total: `list_media_types`, `search_library`, `list_media`, `get_media`,
  `search_metadata`, `add_media`, `delete_media`, `set_monitored`, `search_releases`,
  `grab_release`, `get_queue`, `get_system_health`, `get_setting`, `set_setting`.
- Verified live against the real running server: performed the actual MCP `initialize` handshake,
  confirmed `tools/list` returns all 14 tools with correct JSON schemas, called `list_media_types`
  and confirmed it returns real data, confirmed a request with no API key is correctly rejected
  with 401 (same gate as every other route), and round-tripped a real setting through
  `set_setting`/`get_setting` via actual `tools/call` invocations.

## Round 162 — Podcasts library type
- **Podcasts** — new library type, added to the roster alongside Movies/TV/Books/etc. Unlike
  every other "collection"-shape type, episodes aren't indexer-searched: they come straight from
  the show's own RSS feed, the same "channel monitoring" idea Online Videos already uses for
  YouTube. Add-by-search uses the free, keyless iTunes Search API (`media=podcast`) to resolve a
  show name to its feed URL; from there, a new `checkPodcastFeeds` scheduled job (every 2 hours)
  re-polls each monitored show's feed, inserts any `<enclosure>` not already known as an episode,
  and — with an "http" download client configured — grabs it immediately, since an RSS enclosure
  is already a direct downloadable file URL (no yt-dlp-style resolution step needed the way
  YouTube's opaque video ids require). `runAutoSearch` got the same bypass-indexer-search branch
  Online Videos already has, as a backup grab path for episodes discovered but not yet downloaded.
  Uses the `xml2js` dependency already shipped for indexer/NFO parsing — no new dependencies.
- Verified live against real data end-to-end: searched the real iTunes API for "Radiolab",
  added it, confirmed all 500 real episodes populated from the actual RSS feed with correct
  titles/dates/enclosure URLs, then grabbed one real episode through an "http" download client
  and confirmed it downloaded and imported to the right path (`Radiolab/Patient Zero.mp3`).

## Round 161 — Comic image re-encoding on import
- **Comic Image Re-encoding** (Settings → Media Management) — a real Kapowarr community request
  (issue #143): re-encodes every page image inside a newly-imported CBZ to WebP or re-compressed
  JPEG, usually shrinking a comics/manga library substantially. CBZ only — CBR (RAR) is left
  alone since there's no free/open RAR writer to rewrite one with. Uses `ffmpeg` per page image
  (already shipped in the server image) plus the existing `adm-zip` dependency to rewrite the
  archive in place; off by default, and a failed re-encode (a corrupt page image) is logged and
  skipped rather than failing the whole import.
- Verified live: built a real CBZ with `adm-zip`, ran the actual conversion function against it
  inside the running server container for both WebP and JPEG, confirmed via `ffprobe` that the
  re-encoded page inside the rewritten archive is a valid image at the original resolution, and
  confirmed the setting round-trips through Settings.

## Round 160 — Convert audiobook to chapterized M4B
- **"Convert to chapterized M4B"** (audiobook sub-item page, once ≥2 tracks are downloaded) —
  LazyLibrarian's real advantage AoNarr otherwise lacked: merges every downloaded per-chapter
  file into one M4B with embedded chapter markers, via `ffmpeg` (already shipped in the server
  image for `ffprobe`'s media-info reads, so no new dependency). Uses ffmpeg's concat *filter*
  rather than the concat *demuxer* deliberately — the filter decodes each input properly
  regardless of source codec/container before joining, so it works whether the downloaded tracks
  are uniform or mixed formats/bitrates, unlike the demuxer which needs format-identical inputs.
  Chapter start/end times come from each source track's real ffprobe'd duration, titled from the
  track's own title.
- On success, the original per-track files and `tracks` rows are replaced with a single row
  pointing at the merged file — every other feature that walks the `tracks` table for a
  `multiFilePerChild` sub-item (OPDS, Send to Kindle, the track list UI) already treats "one row
  per downloadable file" as the invariant, so collapsing N tracks into 1 needed no other code
  changes anywhere.
- Verified live: synthesized two short test tracks with `ffmpeg`, ran the real conversion route
  end-to-end, and confirmed via `ffprobe` on the output that both chapter markers landed at the
  right boundaries with the right titles, and that the `tracks` table correctly collapsed to one
  row pointing at the merged file.

## Round 159 — Audiobook narrator field
- **Narrator** field on Audiobook sub-items (Books' equivalent — a `sub_items` column, admin-tagged
  like series, since no metadata provider AoNarr uses returns narrator today). Editable from the
  book's own page the same way Series is; shows a "Narrated by X" poster strip of every other
  audiobook tagged with the same narrator, spanning different authors — same pattern as the Series
  sibling widget from Round 155, one property over. Answers an Audiobookshelf-community ask
  (narrator-level browsing, distinct from author) that doesn't fit Audiobookshelf's own scope as a
  playback platform but fits AoNarr's library-organization role directly.
- Verified live against both SQLite and a real Postgres container (schema migration applies
  cleanly to both), and end-to-end in the browser: tagged two audiobooks under different parent
  authors with the same narrator, confirmed each links to the other with the right parent-author
  label.

## Round 158 — File Permissions (chmod/chown on import)
- **File Permissions** (Settings → Media Management → "File Permissions") — Sonarr/Radarr's
  standard "File Management > Permissions" setting, which AoNarr had no equivalent of: every
  imported/renamed file previously landed with whatever the container's default umask gave it.
  Now configurable — chmod (separate octal for files vs folders) applied on every import/rename
  path, since all of them funnel through the same `moveFile()` helper in `importer.ts`. Chown
  (numeric UID/GID) applies only when the container is actually running as root, since a
  non-root process has no permission to change ownership — silently skipped rather than erroring
  when it isn't. Both are best-effort: a permission op failing (e.g. a filesystem that doesn't
  support chmod) is logged and skipped rather than failing the import itself. Off by default —
  existing installs see no behavior change until explicitly enabled.
- Verified live: set chmod (640 file / 750 folder) and chown (1000:1000) in Settings, confirmed
  they round-trip correctly through the UI, and confirmed the underlying chmod/chown syscalls
  succeed as root inside the actual running server container.

## Round 157 — Delay Profiles + per-connection notification triggers; three gaps that weren't gaps
- **Delay Profiles** (Settings → Quality) — Sonarr/Radarr-style: withhold an *automatic* grab
  (scheduled auto-search and bulk "search selected"/auto-upgrade — never a manual single-release
  grab, which is already an explicit choice) for a configurable number of minutes per protocol,
  optionally scoped to a tag, so a preferred protocol (e.g. Usenet) gets a window to show up before
  settling for the other one. A release's age comes from its own publish date rather than a new
  "first seen by AoNarr" tracking table — it simply becomes eligible once old enough, re-checked on
  the next scheduled search pass, so no extra state or background job was needed. "Bypass if
  highest quality" skips the wait entirely once a release already hits the profile's cutoff.
- **Per-connection notification event triggers** (Settings → Notifications, each provider's own
  tile) — every notification provider (Discord, Slack, generic webhook, Telegram, Pushover, SMTP,
  Matrix, Twilio, Custom Script) can now opt in/out of individual events (Grabbed / Imported /
  Failed / Duplicates found) instead of firing on all four unconditionally. Unset (the pre-existing
  behavior) still means every event, so upgrading doesn't silently mute anyone's existing setup.
- **Three of the five gaps identified while studying awesome-arr's "Beyond *arr" list and the
  Servarr wiki turned out not to be gaps at all, confirmed by reading the actual code rather than
  assuming:**
  - **List Exclusions already exists** — `import_exclusions`/`isExcluded()` is already wired into
    every import list sync path (Trakt, IMDb, Last.fm) plus Recommendations, with its own Settings
    UI. Missed on the first pass because the feature uses different naming than Sonarr's
    ("exclusions", not "list exclusions") — a targeted grep for the wrong string looked like a gap
    that a broader read of `importLists.ts` immediately disproved.
  - **Remote Path Mappings don't apply to AoNarr's architecture** — Sonarr/Radarr need them because
    they trust a download client's own reported absolute file path, which can differ from the *arr
    app's mount point on a different host/container. AoNarr never does that: every download client
    just needs to land a completed file somewhere under one shared `downloadsDir` volume, which
    `findDownloadedFile()` scans and fuzzy-matches directly — there's no download-client-reported
    path anywhere in the import pipeline to translate. Building the feature would have solved a
    problem this app's design doesn't have.
  - **A dedicated "Video Games" library type is redundant** — ROMs already targets PC releases too
    (indexer category 1000/4000/4050/8000 covers Console *and* PC, not consoles alone), already
    uses general video-game databases (RAWG, IGDB, ScreenScraper, TheGamesDB) rather than
    retro-only sources, and its `.zip`/`.7z` extensions already cover how PC game releases are
    typically distributed on indexers. Questarr's actual differentiator — checking a Steam/GOG/Epic
    library you already own against — is a different kind of tool (ownership tracking, not
    acquisition) than anything else in AoNarr, so it was left out rather than force-fit in.

## Round 156 — OPDS catalog feed + Send to Kindle
- **OPDS catalog** (`GET /api/opds`, token-gated the same way the `.ics` calendar feed and IPTV
  M3U/stream routes already are — see Settings → General → "OPDS Catalog") — lets any e-reader app
  that already speaks OPDS (KOReader, Moon+ Reader, Marvin, etc.) browse and download straight from
  Books/Authors, Audiobooks, Comics, and Manga without a separate reading app, the same idea as
  pointing one at a Calibre server. Three-level Atom navigation (root → type → parent item →
  acquisition entries); Audiobooks branch to exposing each individual `tracks` row as its own
  acquisition entry instead of the sub_item, since a `multiFilePerChild` sub_item's `file_path` is
  the whole album folder, not a single downloadable file. Downloads stream through the existing
  Range-support helper (`rangeStream.ts`) so large files/audiobooks support resumable downloads,
  same as IPTV streams already do.
- **Send to Kindle** — a "Send to Kindle" button on a book/comic/manga's own page (Settings → General
  → "Send to Kindle" for the destination address) emails the downloaded file as an attachment to a
  configured Kindle address, reusing the existing SMTP notification settings with the recipient
  overridden. Required adding MIME multipart/mixed message-building (`sendEmailWithAttachment` in
  `smtp.ts`, alongside the existing plain-text `sendEmail`) since the hand-rolled SMTP client had no
  attachment support before. Rejects files over 50MB (Amazon's own Send-to-Kindle attachment cap)
  up front rather than failing partway through the send. Not offered for Audiobooks for the same
  `multiFilePerChild` reason OPDS branches on — there's no single file to attach.
- Verified live: fetched the real OPDS root feed and confirmed valid Atom XML with all four type
  entries, confirmed the token gate rejects a request with no token, confirmed the per-type feed
  queries real library data (empty in this dev instance, correctly so), and confirmed the Send to
  Kindle route's error path (unknown sub-item → 404) and the new Kindle-address setting both round-
  trip through Settings correctly.

## Round 155 — series linking for Books/Audiobooks; Comics/Manga already had it
- **New "Series" feature for Books and Audiobooks** — the one-level-down equivalent of Movies' TMDB
  Collection widget, since a book's own unit is a `sub_item` (Books/Audiobooks group by Author,
  each book is a child), not a top-level media item the way a movie is. Set a series name + numeric
  position (non-integer allowed, e.g. `2.5` for an interstitial novella) on a book's own page —
  it then shows every other book tagged with the same series name (matched case-insensitively,
  admin-tagged since no provider exposes clean series data for any of Books/Audiobooks' six
  providers today — see the per-provider audit in this round's dev notes) as a linked poster strip,
  same visual pattern as the movie Collection widget. Deliberately spans different authors, not
  just siblings under one parent — covers both the common case (a series entirely by one author)
  and shared-universe anthologies across authors, without extra configuration either way.
- **Comics and Manga don't need new code** — AoNarr's existing manual Collections feature
  (`collections`/`collection_items`, its own browse page, ordering, M3U/JSON export) already does
  exactly this: any media_item of any type can belong to any collection, unrestricted. Linking
  comic volumes/reboots or related manga together as a "series" already works today by creating a
  Collection and adding them to it — confirmed by reading the existing route/schema rather than
  building a redundant parallel system.
- Verified live: tagged two books under two *different* authors with the same series name (one
  upper-case, one lower-case, to prove the case-insensitive match), confirmed each book's page
  correctly links to the other as a series sibling with the right parent-author label, in both
  directions.

## Round 154 — AudNexus author bio/photo enrichment
- Wired in **AudNexus** (audnex.us), the free/open community API Round 153 identified as not
  fitting AoNarr's search-provider model — it has no book list at all, only a name/bio/photo per
  author. Added as an "Additional Metadata Sources" enrichment option instead ("Fetch from
  audnexus"), the same role Fanart.tv plays for movies/series/artists: fetches a real bio and
  author photo to pick from in the merge table, without needing to be the item's primary match.
  Available on both Books and Audiobooks.
- AudNexus's `/authors?name=` endpoint is a loose name-directory lookup, not relevance-ranked
  search (a query for one name returns dozens of only-partially-matching people) — results are
  sorted to prefer an exact case-insensitive name match first, and only the first handful get a
  follow-up detail call (the only one that actually returns bio/photo) rather than fetching every
  loose match.
- Verified live: real bio text and author photo URL came back for a live query, and the full
  "Fetch from audnexus" → merge-table → pick-a-field flow worked end-to-end on an actual author
  item.

## Round 153 — iTunes, Hardcover, Goodreads, and Audible metadata providers
- **Four new metadata providers**, sourced from surveying what BookOrbit (a self-hosted book/
  audiobook/comic manager) wires up: **iTunes** (Books, keyless, Apple's public Search API),
  **Hardcover** (Books, needs an API token from hardcover.app), **Goodreads** (Books, keyless —
  see caveat below), and **Audible** (Audiobooks, keyless — see caveat below). All four follow
  Books/Audiobooks' existing author-centric search shape (search finds an author, picking one
  fetches their books as children), same as Open Library/Google Books already do.
- **Audiobooks gets its first dedicated provider.** Every existing audiobook provider was actually
  a book provider reused (Open Library/Google Books have no audio-edition concept at all) — Audible
  is audiobook-specific, sourced from the same unofficial `api.audible.com` JSON endpoint several
  established open-source audiobook tools already rely on (not an official/documented Audible API,
  but a real JSON endpoint, not scraped HTML).
- **Goodreads has no public API anymore** (shut down years ago) — this reads its still-public
  search and author book-list pages instead, the same trade-off BookOrbit and most other "Goodreads
  metadata" tools make today. Verified against live pages before shipping (not guessed blind), but
  it's inherently more fragile than every other provider in AoNarr — it can break without notice
  whenever Goodreads changes their site's markup, unlike an actual API contract.
- **Amazon and AudNexus were considered and deliberately left out.** Amazon (BookOrbit's other
  scraped source) sits behind an active Akamai bot-detection challenge — confirmed live: an
  unauthenticated request gets a bot-verification redirect, not real results, even before touching
  the "needs your own session cookie" requirement. Building a workaround for that is bypassing
  bot-detection, not just parsing public HTML, a different and firmer line than the Goodreads
  scraper above. AudNexus isn't actually a book-search API at all — it's an author-bio enrichment
  source keyed by an Audible ASIN (BookOrbit uses it as a secondary enrichment call after Audible,
  not a standalone search provider), so it doesn't fit AoNarr's "search by title" provider model;
  wiring it in as a fake search provider would just return zero results for every query.
- Verified live: real search results back from iTunes, Goodreads, and Audible (actual titles/
  covers/authors, not just "didn't crash"); Hardcover correctly dispatches to its own code path
  (fails only on "API token not configured", not a generic error); imported a real author via the
  new Goodreads provider and confirmed all 30 of their books came in as children.

## Round 152 — ROM indexer breadth, Duplicates layout fix, manual metadata edit + NFO sync, per-item/library Organize & Rename
- **ROM indexer search broadened again** — `1000,4050` (Console + PC/Games only) was still missing
  PC/Software and anything filed under an indexer's catch-all "Other" category. Now
  `1000,4000,4050,8000` (Console, PC parent, PC/Games explicitly for indexers that don't expand
  parent categories, and Other).
- **Fixed the Duplicates page's layout** — its per-group wrapper was reusing the `.form-panel` class
  (a narrow single-column form style capped at `max-width: 480px`) around a full 9-column table,
  which forced the whole table into a 480px box and spilled everything past it. Replaced with an
  unconstrained panel-styled div, wrapped the table in a proper `overflow-x: auto` container
  (matching the pattern the merge-metadata table already used), and capped/wrapped the title cell
  so an unusually long title can't force the row wider either.
- **Manual metadata editing** on every media page (movie/series/ROM/comic/... — the same shared
  MediaDetail.tsx component every library type's item page already uses) — a new "Edit metadata"
  button reveals a plain title/year/overview/poster-URL form, no provider fetch required first
  (unlike the existing merge-table flow). Saving — from this new form, or from the existing merge-
  apply/rematch flows — now also writes/updates a matching `.nfo` sidecar next to the item's file
  on disk (Kodi/Jellyfin/Emby convention: same basename as the file, `.nfo` extension) if it has
  one, so a media server picks up the correction on its next scan instead of only AoNarr knowing
  about it. Scoped to single-file items (Movies/ROMs/Adult, anything with its own `path`) — an
  episodic/collection parent (TV shows, Music, Books, ...) has no single file of its own to put a
  sidecar next to, only its children do.
- **"Organize & Rename" button** added to both the Library page (scoped to that whole library type)
  and a single media page (scoped to just that one item) — Sonarr/Radarr's "Rename Files" made
  reachable without going through System settings first. Both call the same underlying rename
  logic already shipped; the per-item route/function (`renameOneMediaItem`) is new, extracted from
  the existing whole-library `renameLibraryFiles` the same way Round 148's per-item scan/refresh
  were split out of their whole-library versions.
- Verified live: edited a test movie's overview through the new form and confirmed a `.nfo` file
  appeared on disk with the edited text; confirmed the per-item Organize & Rename endpoint actually
  moved a flat-placed test file into its templated `Title (Year)/` subfolder; confirmed the
  Organize & Rename button renders on a real Library page.

## Round 151 — ScreenScraper, TheGamesDB, Vimeo providers, and manual lessons for Courses
- **ScreenScraper and TheGamesDB** added as ROM metadata providers alongside RAWG/IGDB — both are
  retro/emulation-focused (unlike RAWG/IGDB, which skew modern), so they cover older/obscure
  systems RAWG/IGDB's box art and overview data often miss. ScreenScraper needs a registered dev
  account (id/password) plus your own optional account credentials (raises the anonymous rate
  limit); TheGamesDB just needs a free API key. Both plug into search, the System/Maker auto-fetch
  on Add Media (Round 148), and artwork search (Round 150) the same way RAWG/IGDB already do.
- **Vimeo** added as an Online Videos provider alongside YouTube — search finds a Vimeo user
  (channel), picking one imports their uploaded videos as children, same "search finds a channel,
  children are its uploads" shape YouTube already has. Also wired into artwork search.
- **Courses can now add lessons manually and Manual Import them**, closing the real gap behind
  "turn the URL scraper into search" (there's no public search API any course platform offers, so
  that's not something to safely build — see the discussion that led here). A course has no
  metadata provider, so it never had any children (lessons) for Manual Import's "Target lesson"
  dropdown to offer — a new "+ Add lesson" field on the Manual Import panel creates one with just a
  title (the same minimal shape Scan & Import itself creates when it guesses a child from a
  filename), which then shows up immediately as a Manual Import target. Generic to any collection-
  shape type, not special-cased to Courses, though Courses is the one that actually needed it since
  every other collection type gets its children from a metadata fetch already.
- Verified live: confirmed all three new providers' search dispatch reaches their real code path
  (each failed only on its own "API key not configured" message, not a generic invalid-provider
  error) and that their tiles/fields render correctly in Settings; confirmed adding a Course lesson
  end-to-end — the lesson appears in the Target dropdown immediately and is auto-selected, ready for
  Manual Import to attach a file to it.

## Round 150 — artwork search, NFO/Plex export, and ROM indexer breadth for the secondary libraries
- **Artwork search extended beyond movie/series/artist (Fanart.tv)** to ROMs, Manga, Comics, Online
  Videos, and Adult, each pulling from that type's own metadata provider instead: RAWG screenshots
  + IGDB cover/artworks/screenshots for ROMs, MangaDex's full cover list (often several per manga)
  + AniList's banner art for Manga, ComicVine's volume image at several resolutions for Comics, a
  YouTube channel's branding banner + thumbnail sizes for Online Videos, and ThePornDB's full
  posters array + background (previously only `posters[0]` was ever stored) for Adult. Courses has
  no metadata provider at all (manual-only), so there's genuinely nothing to fetch artwork from —
  the button is correctly absent there, not just hidden. The artwork picker also now shows a
  Backgrounds/banners section (click to use as the poster) for types that actually have one.
- **"Export for Plex" (.plexmatch) button** was hidden for every type except movie/series/anime —
  the server route itself was never type-gated, so this un-gates the button everywhere; a type
  whose external ids aren't tmdb/imdb/tvdb (i.e. everything but movie/series/anime) still exports
  something (title/year), it's just less useful since Plex has no native library type for e.g. ROMs
  — the button's tooltip now says so directly instead of implying it'll always help.
- **NFO export's root tag now follows shape, not a hardcoded type list** — `<tvshow>` for episodic
  (series/anime) and collection-shape types (Music/Books/Comics/Manga/Online Videos/Courses/...),
  `<movie>` only for single-file items (Movies/ROMs/Adult), matching how each is actually organized
  on disk (a parent-with-children folder vs. one file) rather than only ever describing TV shows
  correctly and silently mislabeling every other multi-child type as a movie.
- **ROM indexer search broadened from one category to `1000,4050`** (Console + PC/Games) — Torznab's
  `cat=` param already accepts a comma-separated list natively, so this needed no code change, only
  the config value; previously PC/Games (4050) alone meant every console release was invisible to
  search.
- Verified live: confirmed a Comic item's NFO now exports `<tvshow>` (previously would've been
  `<movie>`) while a Movie's still exports `<movie>`; confirmed the Artwork button appears and
  correctly dispatches to the new ComicVine artwork path (reached the "API key not configured"
  error specific to that provider, not the old blanket "needs a TMDB/TVDB/MusicBrainz id" message);
  confirmed "Export for Plex" renders for a Comic item.

## Round 149 — Courses site logos
- Round 148's site-logo feature (favicon shown above a Site group's tile) covered Online Videos and
  Adult but missed Courses — its auto-detected Site group (Coursera/Udemy/edX, from the course URL
  importer) was created without the `website` param the favicon fetch needs, so it never got a logo.
  Now passes it through, same as everywhere else; an existing Coursera/Udemy/edX group from before
  this fix gets backfilled with a logo the next time a course URL from that site is imported, rather
  than staying tile-less until someone edits it by hand. The generic tile-rendering code (Round 148)
  already worked for any group type, so this was purely a missing `website` param, not new rendering.
- Verified live: created a Coursera Site group through the same `website` param the course-URL
  import path now sends, confirmed the favicon renders on the Courses library tile.

## Round 148 — ROM metadata auto-fetch, merge-table fixes, ffprobe safety fixes, per-item scan/refresh, group logos
- **ROMs Add Media now auto-fetches System, Maker, and Overview.** RAWG/IGDB's search results never
  carried these (only their per-game detail lookup does) — picking a search result now follows up
  with that detail lookup, fills in Overview, and resolves/creates the System → Maker group chain
  automatically (find-or-create by name, same pattern Courses already used for its Site group)
  instead of leaving both blank for the admin to type by hand every time.
- **Fixed the "Additional Metadata Sources" merge table's alignment** — cells defaulted to
  `vertical-align: middle`, so a row with a tall Overview cell next to a short Year cell put their
  radio buttons at different heights instead of a straight line down the row; now pinned to the
  top consistently, and an empty/unavailable cell's "—" lines up under the radios in populated
  cells instead of sitting flush left.
- **Fixed the merge table not going away after "Apply merged metadata"** — it kept showing the same
  stale fetched data forever (looking like Apply had silently failed) because the underlying fetched
  data was never cleared, only the item's own fields were updated. Apply now also clears it, both
  client-side and in the stored `extra_metadata`, so the table collapses back to just the "Fetch
  from X" buttons.
- **Fixed a real corrupt-media false-positive/data-loss risk**: ffprobe was being run against every
  file regardless of type, including ebooks/comics/ROMs, which it can never successfully read. For
  Scan & Import this only produced a noisy `[ffprobe] could not probe ...` warning (the bug
  reported: scanning a Books library logged this for every .epub) — but the exact same unconditional
  probe also ran inside the scheduled Corrupt Media Check job and the per-item "Check for
  corruption" button, which would have eventually flagged and recycled every single Books/Comics/
  Manga/ROMs file in the library as corrupt, since ffprobe failing on those was guaranteed, not a
  real fault. Both now skip ffprobe entirely for a file extension it was never going to understand,
  based on the same real video/audio container list used for other capability gating.
- **Added per-item "Scan & Import" and "Refresh" buttons** to a media item's own page, alongside the
  existing library-wide versions on the Library page — Radarr/Sonarr-style single-item actions
  instead of only being able to re-run either across an entire library. Scan & Import is scoped to
  just this item's own title (won't create unrelated new items); Refresh re-pulls this item's own
  metadata and backfills any missing episodes/children (Round 147's fix), scoped to just this item.
- **Site/system logos on group tiles** (Online Videos, Adult, ROMs): a new Logo URL on
  `library_groups`, shown above a group's name on its tile. Auto-fetched — a new "Site" group
  (Online Videos/Adult) optionally asks for the site's own website and derives a favicon from it (the
  small icon a site exposes for exactly this kind of external identification, not scraped artwork);
  a new ROM "System" group created via Add Media gets IGDB's own platform logo automatically (RAWG-
  sourced games get an opportunistic name-matched IGDB lookup too, if IGDB is also configured, since
  RAWG has no comparable asset). A group's own page also has a manual Logo URL override field for
  anything auto-fetch didn't get right.
- Verified live: created a real system+maker group chain via the new website/logoUrl POST params,
  confirmed the favicon/logo round-trips and renders at 40×40 above the tile's name; confirmed the
  merge table's radio buttons land on the exact same pixel row across columns and the table
  disappears (with `extra_metadata` actually cleared server-side) after Apply; confirmed a fake ROM
  item with a `.json` "file" is no longer flagged corrupt by Check for corruption (previously would
  have been recycled); confirmed the per-item Scan & Import/Refresh buttons render and respond.

## Round 147 — Refresh now backfills missing episodes/children, friendly Custom Columns picker
- Fixed "Refresh" (the per-library button, and the scheduled Library Refresh job) only ever
  updating an item's own overview/poster/year — for an episodic or collection-shape library
  (TV/Anime/Music/Books/Comics/Manga/Online Videos), it never touched episodes/albums/books/etc.,
  so a show added via Scan & Import or a Starr import (which only ever create rows for files that
  already exist) kept showing just its downloaded episodes forever, with no way to discover the
  rest of the season from inside AoNarr. Refresh now also re-pulls the full episode/child list from
  the item's metadata provider and inserts any it doesn't have yet, as monitored+missing — same
  state a normal Add Media gives every episode/child up front, so AoNarr's own search picks them
  up. Never touches an existing row's has_file/file_path, so nothing already downloaded can be
  reset back to missing by a later refresh.
- Custom Columns' "Metadata path" free-text field replaced with a "Field" dropdown of the actual
  human-readable options (Video codec, Audio codec, HDR format, Bitrate, Frame rate, ...) that
  fills in the underlying path for you; a "Custom (advanced)" option at the bottom still allows a
  hand-typed path for anything not listed (e.g. a specific metadata provider's own data). A
  column's tile now shows its friendly field name instead of the raw dot-path too.
- Verified live: pruned a 73-episode show (added via metadata import, tvmaze provider) down to 2
  episodes to simulate a file-only import, ran Refresh, confirmed all 71 missing episodes came back
  with no duplicates and the existing 2 left untouched; confirmed the Custom Columns add form shows
  friendly names, auto-fills the label, and the advanced path input only appears when "Custom" is
  selected.

## Round 146 — fix oversized root folder checkbox, and Radarr/Sonarr import dropping missing items
- Fixed the "Pause grabs at quota" checkbox on a root folder's edit tile (Round 143 regression) —
  it was missing the `width: auto` override every other checkbox in the codebase sets, so it
  inherited the global `input { width: 100% }` rule and rendered stretched to the full field width
  instead of a normal-sized checkbox.
- Fixed Radarr/Sonarr/Lidarr/Readarr import (the "Import from Radarr" etc. button on a library
  page) silently dropping everything the source app hasn't downloaded yet — it only ever fetched
  movies/episodes/albums/books that already had a file, so a monitored-but-still-wanted item in
  Radarr never made it into AoNarr at all, missing or otherwise. Now imports those too, as
  monitored+missing (no file path) — AoNarr's own wanted/missing search picks them up the same way
  it would anything added directly, instead of only ever importing what's already on disk. An
  already-downloaded match is never downgraded back to missing by a later import that happens to
  see it without a file that round.
- Verified live: ran the Radarr import against a mock Radarr instance returning one downloaded and
  one monitored-but-missing movie — confirmed both landed in AoNarr, the missing one as
  `hasFile: 0, monitored: 1` (the same state AoNarr's wanted/missing search already filters on
  everywhere else), and that re-running the import doesn't reset an already-downloaded match.

## Round 145 — custom columns for the library list view
- New Custom Columns page (Configuration → Custom Columns, admin-only): define any field from an
  item's metadata as a column, by dot-path — e.g. `mediaInfo.videoCodec`, `mediaInfo.hdrFormat`,
  `mediaInfo.bitrateKbps` for technical media info, or `extraMetadata.tmdb.overview` for a specific
  metadata provider's data. Scope a column to one library type or leave it blank for all types.
- New `custom_columns` table (id, media_type nullable, label, path, position) + `/api/custom-
  columns` CRUD, admin-only like Tags/AI Providers.
- A library page's "Columns" dropdown (list view) and "Poster info" dropdown (poster view) now list
  every custom column configured for that type (or for all types) alongside the built-in fields
  (Year, Status, Monitored, ...) — pick one and it renders as a real table column or poster info
  line, resolved via the dot-path against the item (mediaInfo, extraMetadata, or any other field).
- Verified live: created a "Video Codec" column pointed at `mediaInfo.videoCodec` with no library
  type set, confirmed it appeared in the Movies library's Columns dropdown and rendered as a real
  table column when toggled on, then deleted it.

## Round 144 — site-wide full-width/centered layout toggle
- New "Switch to full-width layout" / "Switch to centered layout" link next to the theme toggle
  (sidebar footer, or topbar when using the top-nav layout) — applies to every page instead of
  the old hardcoded rule that only gave library pages the full-width treatment. Stored per-browser
  in localStorage (`aonarr_layout_width`) and applied before React renders, same mechanism as the
  dark/light theme toggle, so there's no flash of the wrong width on load.
- Centered (capped at 1200px, actually centered via margin: 0 auto now — previously the 1200px cap
  existed but nothing centered it, it just sat flush against the sidebar with empty space to the
  right) is the default; full-width removes the cap entirely, same as library pages already got.

## Round 143 — per-instance tiles for Root Folders, Quality, and Subtitle Providers
- Root Folders (Settings → Library Sync), Quality Definitions/Quality Profiles/Custom Formats
  (Settings → Quality), and Subtitle Providers (Settings → Import & Subtitles) no longer nest an
  add-form + one giant table inside a single tile's popup. Each already-configured instance now
  gets its own tile directly on the tab's grid (path/name + a short status line, e.g. free space
  or over-quota warning, cutoff, or applies-to), with its own popup to edit or delete just that
  one; a separate "+ Add ..." tile is the entry point for configuring a new one.
- Quality Definitions keeps its inherent worst-to-best rank order (tiles render in rank order,
  each showing "Rank N of 15" and Move up/down controls in its popup — reordering still works the
  same as the old table did) since quality-profile cutoff/allowed-quality logic depends on it.
- Custom Formats' "Format Scores" (score each format per quality profile) was pulled out of the
  Custom Formats tile into its own standalone tile, since it's profile-centric rather than
  format-centric and didn't fit inside a single format's edit popup.
- No backend changes — this only restructures how Settings.tsx builds the tile grids for these
  four sections; all the same API endpoints and handlers are reused unchanged.

## Round 142 — simplified Naming popup
- The Naming tile's popup (Settings → Media Management) listed every library type with its current
  template previewed inline — simplified to just the library name and a "Config" button per type;
  clicking it still opens the same full naming-setup modal (tokens, current template, live
  preview, renaming on/off) as before, one level deeper instead of all at once on the first screen.

## Round 141 — filler clip library for IPTV playlists
- Replaced the single "Filler URL" text field on an IPTV playlist with a proper reusable filler
  clip library: add any number of clips (name, URL, optional category) once, then attach any
  subset to a given playlist — at each insertion point the feed rotates round-robin through
  whichever clips that playlist has attached, instead of always repeating the same one. New
  `iptv_filler_clips` and `iptv_playlist_fillers` tables/CRUD; `filler_url` on `iptv_playlists` is
  no longer read or written (left in the schema, just unused, rather than a migration to drop it).
  A playlist with no clips attached still never inserts anything, same as before.
- Still the same boundary from earlier in this conversation: every clip is a plain URL the admin
  supplies themselves, exactly like before — this round is entirely about managing *your own*
  content better, not about sourcing any.
- Verified live: created two real clips and a playlist with three items via the API, attached both
  clips, fetched the actual M3U output and confirmed the rotation is genuinely round-robin (A, B,
  A across the three insertion points, not just "the same clip every time" with different
  bookkeeping); confirmed the attach/detach UI and the playlist's rotation-order table render and
  behave correctly through real UI clicks; confirmed the two new tables migrate cleanly on both
  SQLite and a fresh Postgres container.

## Round 140 — IPTV playlist manager (last item from the earlier punch list)
- Added a new IPTV Playlists page: build custom M3U playlists a media server (Plex, Jellyfin, etc.)
  can subscribe to as a live-TV/tuner source. An item is either an AoNarr library reference (a
  movie or TV episode, streamed from its own downloaded file) or a raw external stream URL, so a
  playlist can mix AoNarr content with actual external IPTV feeds. New `iptv_playlists`/
  `iptv_playlist_items` tables, `GET /api/iptv/m3u/:id` (the feed itself) and `GET /api/iptv/stream/
  :kind/:id` (serves a library item's file), both gated by their own dedicated token — same
  pattern as the existing `.ics` calendar feed — since a media server subscribes with a plain URL
  and can't send AoNarr's normal auth headers. New `services/rangeStream.ts` adds real HTTP Range
  (206 Partial Content) support, needed for a player to seek within a stream instead of only ever
  playing from the start — nothing in AoNarr served files this way before.
- Optional filler insertion, either after every item or after N accumulated minutes of an item's
  own duration — the filler is always a plain URL the admin supplies themselves. As discussed
  earlier in this same conversation, AoNarr does not and will not source or scrape "free
  commercials found online" — that would mean redistributing content without the rights to, not a
  defensible feature regardless of framing. What's built is playlist management with an
  insertion *mechanism* the admin points at their own legally-held content, not an ad network.
- Verified thoroughly and live: created a real playlist mixing an external URL item and a library-
  referenced movie, fetched the actual M3U output and confirmed the filler was correctly
  interleaved after each item; confirmed the resolved library-item stream URL round-tripped
  through a genuinely wrong first attempt — the initial `req.protocol`/`req.get("host")`-based
  origin came back missing the port (nginx's `$host` proxy variable drops it), a real bug caught
  by testing against the actual proxied stack rather than assumed correct — fixed by preferring
  the existing (previously unused anywhere server-side) "External URL" setting instead. Confirmed
  the fix live with the corrected port present in the feed. Streamed a real 5MB test file through
  the range endpoint both with and without a `Range` header, confirmed the 206/Content-Range
  response for a partial request, and confirmed the returned bytes are a byte-exact match (via
  checksum) against the correct slice of the source file. Confirmed missing/wrong tokens are
  rejected on both the feed and stream endpoints. Confirmed drag-free Up/Down item reordering via
  a real UI click. Confirmed the new tables migrate cleanly on both SQLite and a fresh Postgres
  container.

## Round 139 — AI provider infrastructure (2nd of the earlier AI-matching request)
- Added a new AI Providers page (Configuration): manage multiple AI provider instances, each
  either "local" (an Ollama-style chat API — no key required, though one's accepted for setups
  that gate on one) or "cloud" (any OpenAI-compatible chat completions endpoint — OpenAI itself or
  a compatible proxy, same generic-adapter approach the DDL indexer and Custom subtitle provider
  already use for arbitrary third-party APIs), selectable per instance so both a local and a cloud
  provider can be configured side by side and one flagged as the default. New `ai_providers` table,
  `services/aiClient.ts` (`queryAi()`, with an optional base64 image for a vision-capable model),
  full CRUD + a "Test connection" button (sends a trivial prompt, same pattern indexers already
  offer) under `/api/ai-providers`.
- This is infrastructure only this round — nothing in AoNarr calls `queryAi()` yet. It exists so
  future AI-assisted matching features (the earlier request's own example was a vision-OCR fallback
  for scanned-image-only book PDFs, which last round's ISBN scan explicitly doesn't attempt) have
  somewhere to plug in without each needing its own provider-config UI; wiring an actual feature to
  it is a follow-up once there's a concrete one to build, rather than speculatively bolted onto the
  ISBN scan feature without a specific use decided.
- Verified live: added a real provider through the UI (Ollama-style, pointed at a placeholder
  address) via real clicks, confirmed it round-tripped into the database correctly; clicked "Test
  connection" and confirmed a genuinely unreachable endpoint fails cleanly ("fetch failed") instead
  of crashing the page; confirmed the new `ai_providers` table migrates cleanly on both SQLite and
  a fresh Postgres container (this Postgres check first ran against a stale local `dist/` build
  from an earlier round's manual `tsc` run and silently found nothing — not a shipped-image issue,
  since the real Docker build always compiles fresh from source, but a reminder to refresh that
  local build dir before trusting a dist-based check again).

## Round 138 — Book ISBN scan-to-match (1st of the earlier AI-matching request)
- Added "Scan for ISBN" on a book's own page (Books library): scans the downloaded file's first
  and last 15 pages (PDF) or its embedded metadata (EPUB's OPF `dc:identifier`) for an ISBN, then
  looks it up directly via Open Library's ISBN endpoint (a key-value lookup, not a fuzzy search —
  no API key needed, trustworthy enough to apply without a confirmation step, the same trust level
  a subtitle's exact moviehash match already gets) and updates the book's title/release date/cover/
  external id from the result. New `services/bookIsbnScan.ts`, `POST /api/media/:id/subitems/
  :subItemId/scan-isbn`, new `pdf-parse` dependency for the PDF text layer.
- ISBN-10 and ISBN-13 are both detected (a labeled "ISBN ..." occurrence tried first, then any
  bare 10/13-digit run) and checksum-validated before being trusted — a three-number run that
  merely looks ISBN-shaped doesn't get treated as one. `.mobi`/`.azw3` aren't supported (no
  practical pure-JS parser for either); a scanned-image-only PDF with no text layer at all is
  correctly treated as "not found" rather than guessed at, since no OCR is attempted this round.
- Verified thoroughly, not just by code review: unit-tested the ISBN regex+checksum logic directly
  (5 cases, including deliberately rejecting an invalid checksum); built a real EPUB fixture (a
  genuine zip with container.xml + OPF) and confirmed extraction end-to-end; hand-built two real
  40-page PDFs to specifically prove the "first/last 15 pages" restriction itself works, not just
  that ISBN detection works somewhere in the document — one test placed a valid ISBN on an
  excluded middle page (correctly NOT found) and a different valid ISBN within the last-15 range
  (correctly found), the other confirmed the same for the first-15 range. Ran the full route live
  against a real book (a genuine EPUB with a real-world ISBN) and a real, live Open Library API
  call — confirmed via both a direct API call and a real UI click that it correctly renamed the
  book, set its release date/cover/external id, and persisted. Also caught and fixed a real bug
  this live UI test surfaced: the scan response (a bare sub_items row, no `parent` field) was
  replacing the whole frontend state wholesale, silently losing the parent-breadcrumb context and
  making the "Scan for ISBN" button itself disappear after first use — fixed by merging the
  response onto existing state instead of replacing it.

## Round 137 — Plex watchlist sync (8th and final Starr feature-gap list item)
- Added Plex watchlist auto-sync, mirroring the existing Trakt List Sync pattern: adds anything new
  in the configured Plex account's watchlist as a monitored library item (movies as single items,
  shows with their full episode list fetched via TMDB) — "auto-add, never remove," same as Trakt
  sync. Uses the same server token already configured for Media Server Sync in Settings (that
  token belongs to a specific Plex account, so this is that account's own watchlist — there's no
  AoNarr concept of linking a household account to its own separate Plex account, which a fuller
  per-user version would need). New `services/plexWatchlistSync.ts`, a `plexWatchlistSyncEnabled`
  setting (default off, next to the other Media Server Sync toggles), a scheduled job (every 12
  hours, same cadence as Trakt sync), and a "Run Plex watchlist sync now" button on System →
  Maintenance next to the existing Trakt sync one.
- Plex deprecated the old `metadata.provider.plex.tv` watchlist endpoint — this uses the current
  `discover.provider.plex.tv/library/sections/watchlist/all` one Plex's own client libraries use
  now. Reuses `mediaServer.ts`'s existing Plex `Guid`-array external-id parser (exported this round
  for reuse) rather than duplicating that logic; an item with no TMDB id in its Guid list is
  skipped rather than guessed at by title.
- Verified live: confirmed the manual "run now" trigger correctly no-ops with `{added: 0}` while
  disabled (the default); enabled it with a placeholder token and confirmed the request actually
  reaches Plex's real `discover.provider.plex.tv` endpoint and a 401 (invalid token) comes back
  wrapped as a clean `{added: 0, error: ...}` instead of crashing; confirmed the new Settings
  toggle persists through a real UI interaction. A real populated watchlist sync isn't exercised
  end-to-end here for lack of a real Plex account token in this dev environment — same disclosed
  limitation as the other third-party-credential-gated rounds on this list.
- This closes out the 8-item Starr feature-gap list from the earlier research round: minimum
  availability, TMDB collections, daily series type, bulk rename files, subtitle HI/forced
  preference, automatic subtitle sync, the Discover page, and this.

## Round 136 — Discover page (7th of the Starr feature-gap list)
- Added a new Discover page (Overseerr/Jellyseerr-style): trending movies and TV this week from
  TMDB, browsable with posters instead of only search-then-request. Each tile is cross-referenced
  against the library by TMDB id and shows "In library" when already there; otherwise admins get a
  one-click "Add" (straight into the library, same `/metadata/import` path other add flows use)
  and household accounts get "Request" (submits through the existing request queue, including its
  duplicate-request confirmation). New `GET /api/discover` scopes results to whichever of
  Movies/TV the requesting account actually has access to (or both, for an admin) and skips the
  TMDB calls entirely if neither library is accessible.
- Fixed an adjacent, pre-existing gap this surfaced: household accounts had no navigation link to
  the Requests page at all — the page itself already rendered a full submission form for them
  (`Requests.tsx`'s `!auth.isAdmin` branch), but nothing in the sidebar/topbar ever pointed at it,
  so the only way in was typing the URL by hand. Household accounts now see "Discover" and
  "Requests" as their own nav links, alongside "Account" — an admin's equivalent links stay in the
  existing "Manage" group, unchanged.
- Verified live: confirmed the page renders cleanly with a clear, non-crashing error when no TMDB
  key is configured (this dev environment has none); confirmed the "Discover" nav link appears in
  the admin "Manage" group; created a real household test account, logged in as it, and confirmed
  it independently sees "Discover" and "Requests" in its own nav (previously entirely absent) and
  that Discover's copy correctly reads "Request" instead of "Add" for that role. An actual populated
  trending list (needing a real TMDB key) isn't exercised end-to-end here — same disclosed
  limitation as other rounds depending on third-party credentials this dev environment lacks.

## Round 135 — automatic subtitle sync (6th of the Starr feature-gap list)
- Added Bazarr-style subtitle timing sync: after a subtitle downloads, AoNarr re-aligns its
  timestamps against the video's own audio track using `ffsubsync` (voice-activity detection,
  entirely local — no external API, no network round-trip beyond the initial subtitle download
  itself). New `services/subtitleSync.ts`; both server Dockerfiles (`server/Dockerfile` and
  `Dockerfile.combined`) now install `python3-pip` and `pip install ffsubsync`.
- Skipped for an OpenSubtitles exact moviehash match — that's already the most reliable timing
  signal available (the file matched byte-for-byte against a known release), so spending the sync
  pass (30s–2min depending on file length) would cost time for no benefit. Runs for everything
  else, including "Custom" provider results, which carry no confidence signal to check at all.
  New `subtitleSyncEnabled` setting (default enabled) in the Subtitle Providers tile to turn it off
  entirely. Best-effort and non-destructive: on any ffsubsync failure the original subtitle file is
  left untouched (writes to a temp path first, only replaces the original on success) — a
  mistimed-but-present subtitle beats none at all.
- Verified live end-to-end, not just by code review: confirmed `ffsubsync` actually installs and
  runs inside the built server image; generated a real 5-second test video (ffmpeg) and a
  deliberately-offset test subtitle inside the container, ran the exact `ffsubsync` invocation
  `subtitleSync.ts` uses, and confirmed it correctly detected and corrected a real timing offset
  (produced a `.010s`-shifted, properly realigned output file). Also confirmed the new Settings
  toggle round-trips through a real UI interaction. The subtitle-download half of the pipeline
  (OpenSubtitles search/download itself) isn't exercised here for lack of a real API key in this
  dev environment — same disclosed limitation as prior rounds; the sync step this round actually
  adds is independently and fully verified regardless.

## Round 134 — subtitle hearing-impaired/forced preference + smarter pick (5th of the list)
- Added Bazarr-style subtitle refinements to the existing OpenSubtitles integration: an
  OpenSubtitles provider can now require or exclude hearing-impaired subtitles, and separately
  require or exclude "forced" (foreign-dialogue-only) subtitles, via two new selects on its add
  form — stored in the provider's existing `config` JSON column (previously only used by Custom
  providers) and passed straight through as OpenSubtitles' own `hearing_impaired`/
  `foreign_parts_only` query params.
- Replaced the "just take the first result with a file id" pick with `pickBestSubtitle()`: an
  exact moviehash match (OpenSubtitles' own byte-for-byte file match, the most reliable signal
  available) wins outright when present; otherwise the most-downloaded result is used as a
  popularity/trust proxy, since OpenSubtitles' v1 API has no single normalized confidence score
  the way a hash match does. A "custom" provider (no such fields to read) still just takes the
  first result, unchanged.
- Verified: unit-tested `pickBestSubtitle()` directly — hash match wins over a much-more-downloaded
  non-match, highest download count wins when no hash match exists, custom-provider behavior is
  byte-for-byte unchanged; added a real OpenSubtitles provider through the Settings UI with both
  new selects set (Exclude hearing-impaired, Require forced) via real clicks and confirmed the
  exact preference values round-tripped into the database's stored config. An actual live
  OpenSubtitles search/download isn't verified here for lack of a real API key in this dev
  environment — same disclosed limitation as other rounds depending on third-party credentials.

## Round 133 — bulk "Rename Files" (4th of the Starr feature-gap list)
- Added Sonarr/Radarr-style "Rename Files" — a bulk action (System → Maintenance, optionally
  scoped to one library type) that retroactively re-renames every already-imported file whose
  current path no longer matches its type's current naming template, for after you've changed a
  template and want existing files to catch up instead of only new imports picking it up. A file
  already at the correct computed path is skipped (no move, no DB write); the now-empty old parent
  folder(s) are cleaned up after a move, same as a fresh import leaves behind. New
  `renameLibraryFiles()` in `services/importer.ts` and `POST /api/media/rename-files?type=`.
- Music (the one collection type with multiple files per child) is deliberately skipped — its
  individual track filenames are always kept as-downloaded rather than templated, so a template
  change there only affects the album *folder* name, a different and riskier operation than this
  function's per-file model handles; the skipped count is still reported rather than silently
  doing nothing.
- Verified live end-to-end against the real filesystem: seeded a movie with a file at a
  deliberately "wrong" path, ran the bulk action via a real UI click, confirmed the file actually
  moved on disk to the naming template's computed path, the old now-empty folder was removed, and
  the database's stored path updated to match; confirmed re-running immediately after is a clean
  no-op (nothing left to rename).

## Round 132 — daily/talk-show series type (3rd of the Starr feature-gap list)
- Added Sonarr-style "series type" for episodic libraries (TV Shows, Anime): "Standard" (default,
  unchanged behavior) searches and matches releases by season/episode; "Daily" searches and
  matches by air date instead — talk shows, news, and similar content are released as
  `Show.Name.2024.08.25.1080p...`, not `S01E05`, so season/episode matching never finds them.
  New `series_type` column on `media_items`, editable per item on its detail page (a "Series type"
  row next to the movie-only "Minimum availability" one from two rounds ago).
- `releaseParser.ts` now detects a full date (`2024.08.25`/`2024-08-25`/`2024 08 25`, month/day
  range-checked to avoid false-matching an unrelated three-number run) alongside the existing
  season/episode detection, and a new `releaseMatchesAirDate()` — both the scheduler's auto-search
  and the importer's downloaded-file matching branch on the item's series type to use date-based
  or season/episode-based matching, whichever applies.
- New `{airDate}` naming token (`YYYY-MM-DD`) available in the naming-template picker for episodic
  libraries, so a daily show's files can be named by date instead of season/episode if desired —
  the naming template is still one setting per media type (not per-series), so a household mixing
  daily and standard shows in the same TV Shows library needs a template that works for both, or
  to accept the standard one applying to daily shows' folder structure too; only search/matching
  is fully per-series-independent this round.
- Verified live: confirmed date detection and matching directly (both `.`/`-` separators, correctly
  rejecting a plain movie release with no month/day pair, correctly leaving a normal S01E05
  release's `airDate` null); seeded a series item and changed its "Series type" to Daily via a
  real UI click, confirmed it persisted; confirmed the `{airDate}` token appears in the naming
  picker with a working live preview; confirmed the new column migrates cleanly on both SQLite and
  a fresh Postgres container. The actual scheduler search-query change (building a date-based query
  instead of S/E) is verified by code review — no indexers configured in this dev environment to
  drive a live auto-search run against.

## Round 131 — TMDB collection browsing (2nd of the Starr feature-gap list)
- A movie's detail page now shows its TMDB franchise/collection (e.g. "The Lord of the Rings
  Collection"), if it belongs to one, with every other entry in the collection alongside it —
  poster, title, year, and either an "In library" badge (linking straight to it) or a one-click
  "Add" button for anything missing, reusing the same `/metadata/import` add path Recommendations
  already uses (same quality profile/root folder as the movie you're viewing). New
  `fetchTmdbCollectionFor()` in `services/metadata.ts` (a movie's collection membership only comes
  back from TMDB's `/movie/{id}` details endpoint, not search results, so this is a separate
  lookup) and `GET /api/media/:id/collection`, which also cross-references every part against the
  library by TMDB id.
- A movie with no TMDB collection (most movies) or with a collection but no other released
  entries yet just shows nothing extra — no empty section, no error.
- Verified live: seeded a movie with a fake TMDB id, confirmed the route correctly wraps a TMDB
  401 (invalid/placeholder key, no real key available in this environment) as a clean 400 instead
  of crashing, confirmed a non-movie type is rejected with a clear message, and confirmed the
  detail page renders normally with no console errors when the collection fetch fails — the
  section just doesn't appear, exactly as intended. A real end-to-end fetch against live TMDB data
  (a movie that actually belongs to a collection) isn't verified here for lack of a real TMDB API
  key in this dev environment — same disclosed limitation as prior rounds that depended on a
  third-party credential this environment doesn't have.

## Round 130 — minimum availability (1st of the Starr feature-gap list)
- Added Radarr-style "minimum availability" gating for single-file libraries (Movies, ROMs,
  Adult — Movies is the real driving case): `announced` (default, today's behavior) searches as
  soon as an item is added; `inCinemas` waits until its release date has passed; `released` waits
  release date plus a configurable delay (default 90 days). Since AoNarr only tracks one release
  date per item rather than TMDB's separate theatrical/digital/physical dates the way Radarr's own
  four-tier version does, `released` is an approximation of a digital/home-release window rather
  than a real digital-release-date lookup — disclosed in the Settings tile's own description.
  Gates the scheduled auto-search only; manual search is never blocked, same convention as Quiet
  Hours/Search Window.
- New `minimum_availability` column on `media_items`, set per item (editable on its detail page,
  defaulting to a new `defaultMinimumAvailability` setting when added) and a `minimumAvailability
  ReleasedDelayDays` setting (default 90) — both configured from a new "Minimum Availability" tile
  under Settings → Media Management.
- Verified live: seeded a movie with a future release date and `inCinemas` via direct DB insert,
  confirmed the API round-trips both new fields correctly; changed it to `released` through a real
  UI click on the media detail page's new "Minimum availability" selector and confirmed it
  persisted; set and confirmed the new Settings tile's default-availability field via a real UI
  interaction. The actual auto-search skip itself is a straightforward date-comparison function
  verified by code review (no indexers/download clients configured in this dev environment to
  drive a full scheduler run against).

## Round 129 — SABnzbd premature-completion bug + manual import
- Fixed a SABnzbd download getting marked as failed and never imported despite completing fine.
  `getStatus` (`server/src/services/downloadClient.ts`) reported "completed" the moment a job's
  queue percentage hit 100 — but SABnzbd still has to verify/repair/extract/move the result after
  that, all while sitting in the queue at 100% with a status like "Extracting" or "Repairing". The
  importer raced that post-processing, didn't find the final file yet, and the queue item got
  marked failed on the very first (premature) attempt — never retried, since a failed import moves
  on to searching for a different release instead of re-trying the same one. Real completion (and
  real failure) can only be told apart once a job actually leaves the queue and lands in SABnzbd's
  history, so `getStatus` now checks the queue first and, for any id that's disappeared from it,
  looks it up in history instead of guessing from percentage alone.
- Added manual-import to the Activity page for exactly this kind of case (or any other reason the
  automatic matcher can't find/place a file on its own): a "Retry import" button re-runs the
  automatic matcher against a `failed`/`completed` queue row, and a "Manual import..." button opens
  a picker listing every file in the downloads directory matching that library's file types
  (newest first) so the admin can point AoNarr at the right one directly, bypassing the fuzzy
  title-match entirely. New `POST /api/activity/queue/:id/retry-import`, `GET
  /api/activity/queue/:id/import-candidates`, and `POST /api/activity/queue/:id/manual-import`
  routes; the last two reuse `importer.ts`'s existing placement logic via a new optional
  `manualSourceFile` argument on `importQueueItem`, with a path-traversal guard confirming the
  picked file is actually inside the downloads directory.
- Verified live end-to-end against a real SQLite instance: seeded a failed queue item plus a
  correctly-named file, confirmed "Retry import" found it via the existing fuzzy matcher and
  imported it; seeded a second failed item with a deliberately unrelated filename the fuzzy matcher
  would never pick, confirmed "Manual import..." lists it and importing it via a real UI click
  works; confirmed the path-traversal guard rejects a file outside the downloads directory (tried
  `/etc/passwd`). No live SABnzbd instance available to reproduce the original race directly — the
  `getStatus` fix is verified by code inspection and against SABnzbd's documented API behavior
  (queue percentage reaching 100% while `status` is still a post-processing stage, then the job
  disappearing from the queue into history on true completion).

## Round 128 — AllDebrid grabs hanging forever (4th pass on #1)
- Found a second, independent bug in the same `/magnet/status` polling loop the previous round's
  fix touched: AllDebrid's `data.magnets` is **always an array** — even filtered down to a single
  `id` — never a bare object. The code read it as a single object (`magnet.statusCode`), which was
  always `undefined`, so neither the "Ready" check (`=== 4`) nor the failure check (`>= 5`) ever
  fired. The loop just polled every 5 seconds forever, never erroring and never completing — the
  exact "grab started but stuck" symptom from the reporter's Unraid throughput screenshot on
  https://github.com/aon082910/AoNarr/issues/1, which predates the previous round's fix and was
  never actually explained by it. Fixed by indexing `magnets[0]` (`server/src/services/
  downloadClient.ts`), confirmed against AllDebrid's own documented `/v4.1/magnet/status` response
  shape.
- Double-checked the other two AllDebrid response readers this round touches indirectly
  (`/magnet/files`, `/link/unlock`) against AllDebrid's docs — both already match the documented
  shape, no further bugs found there.
- Still no live AllDebrid premium account to test end-to-end against; this fix is verified against
  documented API shapes and by inspection of the polling loop's control flow, same disclosed
  limitation as the previous three rounds on this issue.

## Round 127 — tile+popup pattern rolled out to remaining settings pages
- Following confirmation on the Notifications template, applied the same tile-grid + popup pattern
  to the rest of the punch-list's 12 pages. Settings.tsx's other six tabs (Metadata Providers,
  Media Management, Indexer Options, Library Sync, Quality, Import & Subtitles) now render each
  logical section as a tile that opens a `Modal` popup, instead of one long unbroken vertical page.
- New `SettingsSectionTiles` component (`components/SettingsSectionTiles.tsx`) generalizes last
  round's `SettingsProviderTiles` for sections whose content isn't a flat key/value field list —
  Root Folders, Quality Profiles, Custom Formats, and similar sections keep their own existing
  table/CRUD UI verbatim inside the tile's popup; only the entry point changed, not the section's
  own logic.
- Metadata Providers additionally got a `SettingsProviderTiles` instance (13 providers: TMDB, OMDb,
  TVDB, Trakt, Discogs, Google Books, Last.fm, Fanart.tv, Comic Vine, RAWG, IGDB, YouTube Data API,
  ThePornDB) — same pattern as Notifications, since it's a flat provider-key list.
- Download Clients, Users, Remote Library, and Friend Libraries pages converted from an "+Add"
  modal plus a table of existing entries to a tile grid where each existing entry is itself a tile;
  clicking one opens a full edit popup (pre-filled, Save/Delete) instead of the previous
  add-only-with-inline-delete pattern — Remote Library and Friend Libraries needed new `PATCH
  /api/remote-instances/:id` and `PATCH /api/friend-libraries/:id` routes added server-side since
  only create/delete existed before. Users' Active Sessions and Request Stats tables became their
  own tiles via `SettingsSectionTiles` for consistency with the rest of the page. System page's
  Backups tab (Backup & Restore, Scheduled Backups) converted the same way.
- Verified live in-browser end-to-end: all converted pages render their tiles with correct
  labels/descriptions/badges; a metadata provider tile (TMDB) saves correctly through a real
  click+type+Tab flow; Root Folders' full add-form+table renders intact inside its popup; a
  download client's full add → edit (pre-filled) → delete cycle round-trips correctly against the
  live API.

## Round 126 — tile+popup settings pattern (Notifications template)
- Long settings pages with many similar "provider" integrations (Notifications had 9: Discord,
  Slack, Generic Webhook, Telegram, Pushover, SMTP, Matrix, Twilio, Custom Script) used to be one
  unbroken vertical form. Added a reusable `SettingsProviderTiles` component — a tile grid with a
  "Configured"/"Not configured" badge per provider, click a tile to open a `Modal` with just that
  provider's own fields, saved through the same `saveSetting` path every other settings field
  already uses. Applied it to the Notifications page as the first instance of the pattern.
- This is a template: the other tile-view candidates from the same request (Metadata Providers,
  Media Management, Indexer Options, Library Sync, Quality, Import & Subtitles, Backups, Remote
  Library, Friend Libraries, Download Clients, Users) are intentionally not converted yet, pending
  confirmation that this first page looks/feels right.
- Verified live in-browser: all 9 tiles render with correct labels/descriptions/configured-state
  badges; opening a tile's popup, editing a field, and blurring it persists through `PUT
  /api/settings/:key` exactly as before, and the tile's badge updates to "Configured" once saved.
  (An earlier round of manual testing looked like a broken save path, but was two compounding test
  artifacts, not a real bug: a stale browser session token left over from a prior container
  rebuild was causing background 401s, and a synthetic `blur` event doesn't bubble the way React's
  delegated `focusout` listener expects — a real click+type+Tab flow saves correctly.)

## Round 125 — Jackett indexer sync
- Added a Jackett equivalent of the existing Prowlarr indexer sync — new `services/jackettSync.ts`,
  mirroring `prowlarrSync.ts`'s pattern (pull the configured-indexer list, mirror into AoNarr's
  `indexers` table via each indexer's own Torznab proxy URL, match existing rows on a stashed
  provider id so re-running updates rather than duplicates) but adapted to Jackett's real
  differences: string slug ids instead of Prowlarr's integers, no protocol field since Jackett is
  torrent-only (no Usenet), and a different per-indexer Torznab proxy path
  (`/api/v2.0/indexers/{id}/results/torznab`, `/configured=true` on the list endpoint, `X-Api-Key`
  header instead of Prowlarr's own header name).
- New `POST /api/indexers/jackett-sync` route, "Sync from Jackett" button on the Indexers page, a
  scheduled `jackettSync` job (every 6 hours, same cadence as Prowlarr's), and a "Jackett Sync"
  settings panel (URL + API key) next to the existing Prowlarr one.
- Verified live against both SQLite and Postgres: confirmed the missing-config error ("Jackett URL
  and API key must both be set") from both the manual sync button and the scheduled job, and the
  unreachable-host error ("Failed to reach Jackett: fetch failed") from the manual sync route —
  identical on both dialects, and both Sync buttons render correctly on the Indexers page.

## Round 124 — media server sync options decoupled from auto-archival
- Watch status previously only got refreshed on a schedule as a side effect of the auto-archival
  job (`archiveEnabled`) — an admin who wanted AoNarr to track what's been watched (e.g. to feed
  the Dashboard's Recently Watched widget) without wanting files auto-archived had no recurring
  sync, only the on-demand dashboard fetch or webhook events. Added an independent
  `watchStatusSyncEnabled` setting + new `watchStatusSync` job (every 30 minutes) that polls the
  media server and records new watch events on its own schedule, entirely decoupled from archival.
- Added a second new sync option, `mediaServerScanSyncEnabled` + `mediaServerScanSync` job (every 6
  hours): a genuine full media-server library scan, distinct from the existing per-import targeted
  refresh (`refreshMediaServerLibrary`, still fires on every import regardless of this setting) —
  useful when files land outside AoNarr's own import path and need the media server to notice them.
- New `triggerFullMediaServerScan()` in `services/mediaServer.ts` (Plex: refresh each movie/show
  section with no path param — a whole-section scan, not `refreshMediaServerLibrary`'s per-path
  targeted one; Jellyfin/Emby: the same `/Library/Refresh` call, already a full scan regardless of
  path). New `syncWatchStatusFromMediaServer()` in `services/mediaServerWebhook.ts` — fetches the
  three lookup tables (media_items/episodes/sub_items) once and matches every watched file in
  memory, rather than the existing per-webhook-event `recordWatchEvent`'s fresh 3-table-scan-per-call
  pattern, which would be wasteful called in a loop over potentially hundreds of watched titles. A
  new `watchStatusSyncLastRunAt` setting acts as a cursor so already-recorded watches aren't
  reinserted into `watch_events` every single 30-minute cycle.
- Settings page: renamed the old "Watch-status Auto-Archival" panel to "Media Server Sync" with the
  two new toggles up top and auto-archival now clearly presented as one of several independent sync
  options underneath, not the panel's sole purpose.
- Verified live against both SQLite and Postgres: confirmed both new jobs appear on the Jobs page,
  enabled both settings via the API, and confirmed both jobs run cleanly with no error when no
  media server is actually configured (correctly no-op via `getMediaServerConfig()` returning null)
  — identical behavior on both dialects.

## Round 123 — Recommendations view-more, calendar day pages, Duplicates dismiss + richer info
- Recommendations page: each section (Movies/TV Shows/Music) now shows 12 items initially with a
  "View more" button revealing the rest — the backend already returns up to ~25 per section (5
  library items × 5 similar results each), the UI just dumped all of them in one unbounded grid.
- Added a real, bookmarkable/shareable per-day calendar page (`/calendar/:date`) alongside the
  existing month view's click-to-expand inline panel — "Open day page" link added to that panel.
  Every entry now gets a clear description via a new shared `describeCalendarEntry()` (e.g. "New
  episode — S01E05 - Title", "Album release — Title", "Book release — Title", vs. the old generic
  label), used by both the month view's panel and the new day page so they stay consistent. Note:
  AoNarr stores one `release_date` per movie/collection-child, not a theatrical/digital/physical
  split — TMDB does expose per-region/type release dates via a separate endpoint, but wiring that
  in needs a schema change and is scoped as follow-up work, not attempted here.
- Duplicates page: added a "Not a duplicate — keep both" action (new `POST /api/duplicates/dismiss`)
  — marks a group's identity as dismissed so `findDuplicateGroups()` stops returning it (and the
  Round 118 scheduled notification job stops flagging it too) without touching either item, unlike
  Merge. New `duplicate_group_seen.dismissed` column (added via the established `ensureColumn`/
  `ADD COLUMN IF NOT EXISTS` pattern, not a fresh table, since Round 118's table already exists).
  Also added more per-item info to the comparison table: quality, monitored status, and which
  metadata providers each item is actually matched to (the clearest signal for telling a genuine
  duplicate — both matched the same tmdb id — from two different works that just share a
  title/year).
- Added 2 new automated tests (`dismissDuplicateGroup` hides a group without touching either item;
  dismissing twice doesn't error) to the existing `duplicateCheck.test.ts` suite — full suite (13
  tests) passes identically on both SQLite and Postgres, confirming the `ON CONFLICT ... DO UPDATE`
  dismiss upsert (valid standard syntax on both dialects, no branch needed) works on both.

## Round 122 — nav reorder, topbar dropdown fixes, library tile-view width, cast photo crop bug
- Reordered top-level nav: Dashboard, Search, Library, Account — Search now renders as its own
  hardcoded link between Dashboard and Library (previously after Library along with everything
  else). Moved Requests and Collections into the Manage group, What's New into System. Every admin
  group's links (Manage/Configuration/System) now sort alphabetically via `.sort()` on the array,
  not just a one-time manual reorder — stays alphabetical if a page is ever added to a group later.
- Fixed two real, precisely-diagnosed topbar bugs (live-measured via computed styles, not guessed):
  the "Library ▾" dropdown trigger sat 8px lower than its sibling `<a>` nav links — root cause was
  the base `button` rule's `margin-top: 16px` (meant for a button under a stacked label) still
  applying inside the topbar's flex-centered row, which `align-items: center` then split in half
  visually. The trigger also had a distinctly darker background than its siblings — it inherited
  `.select-like`'s `background: var(--input-bg)` (near-black, designed for toolbar select/input
  contexts), while plain nav links are transparent over the topbar's own lighter `--panel` grey.
  New `.topbar-trigger` class resets both; verified live the trigger is now pixel-identical in
  height/top position to a sibling link and matches its transparent background.
- Library pages (poster/list view) now stretch to the full available width instead of being capped
  at the app-wide 1200px `.content` max-width (meant for text-heavy pages) — verified at 1920px
  viewport: grid width went from a 1200px cap to 1848px.
- Fixed the poster-size `<select>`'s text being clipped by its own dropdown arrow (`maxWidth: 140`
  wasn't wide enough for "X-large posters" plus the arrow's reserved padding) — widened to 190px.
- Added a "N per page" dropdown (30/60/100/250, namespaced per library type like the sort/status
  fix in Round 121) to the library pagination bar — now shown whenever a library has at least one
  item, not only once already paginated, so it's actually discoverable.
- Fixed a real, previously-unnoticed bug: cast photos on Media Detail and the Person page rendered
  zoomed into a small top-left corner instead of the whole photo. Root cause: both used
  `className="poster"` without the `.card` ancestor the shared `.card .poster` CSS rule requires to
  apply its `background-size: cover; background-position: center` — outside that ancestor, the rule
  never applied at all, so a real photo (typically several hundred px) rendered at native resolution
  anchored top-left, showing only a small crop. Fixed by setting the same background properties
  inline directly on the two affected divs. Audited every other `className="poster"` site in the
  codebase (8 more files) — all already sit inside a proper `.card` ancestor, so this was isolated
  to exactly these two spots.
- Frontend-only round — no server/DB changes, so no dual-dialect verification needed this time.

## Round 121 — library filter/pagination regressions, AllDebrid "no files" fix
- Fixed a real regression from Round 113's pagination work: the status filter's `localStorage` key
  (`aonarr_library_status`) was global, not per library type — picking "Downloaded" on Movies
  silently made every other library (Series, Music, ...) load with the same `has_file = 1` filter
  applied, since they all read/wrote the same key. Namespaced per type
  (`aonarr_library_status_${type}`/`aonarr_library_sort_${type}`), plus a re-sync effect for the
  case where the component doesn't remount when switching type on the same route.
- Fixed a second regression from the same round: pagination's `page` lived in plain React state,
  invisible to the URL — navigating to a media item and back reset the library to page 1 no matter
  which page was actually being browsed. `page` now lives in the URL (`?page=N`) via
  `useSearchParams`, so browser back/forward restores it like any other navigable state. Verified
  live: set Movies to "Downloaded" (correctly showed only the 1 downloaded item), navigated to
  Series (correctly showed all 65 unfiltered), paged to page 2, opened an item, pressed back —
  landed back on `?page=2`, not page 1.
- Fixed GitHub issue #1's third recurrence (AllDebrid grabs failing) — the real root cause this
  time: AllDebrid's `/magnet/status` endpoint stopped including a `links` field entirely as of
  their v4.1 API (file/link data moved to a dedicated `POST /v4/magnet/files` endpoint) — the
  adapter was still reading `magnet.links` from the v4.1 status response, which had already gone
  from "has the wrong shape" (the previous two fixes) to "doesn't exist there at all", producing
  "AllDebrid reported no files" on every grab that actually finished caching successfully. Added
  `callFiles()`, which calls the dedicated endpoint and recursively flattens its file-tree response
  (files carry `n`/`s`/`l`; folders carry `n`/`e` with nested children) into the flat link list the
  rest of the download loop already expects.
- Verified the fix against AllDebrid's documented v4/v4.1 API response shapes (via their published
  docs, since testing requires a live premium account this environment doesn't have) — commented on
  the issue explaining the root cause and asking the reporter to confirm against their real setup
  before closing, rather than claiming it's resolved a third time without their confirmation.

## Round 120 — accessibility pass
- `Modal.tsx` (used by every "Add X" flow across the app) now: traps Tab/Shift+Tab focus within the
  dialog instead of letting it escape to inert page content behind the overlay, closes on Escape,
  restores focus to whatever triggered it on close, has `role="dialog"`/`aria-modal="true"`/
  `aria-labelledby`, and its close button has `aria-label="Close dialog"`. Caught and fixed a real
  bug while building this: initial autofocus first landed on the header's own "✕" close button
  (earlier in the DOM than any form field) instead of the modal's first real field — fixed by
  searching only within the content area, not the whole panel.
- `DropdownMenu.tsx` (used by every "View"/"Columns"/menu-style control) now closes on Escape and
  returns focus to its trigger button, and the trigger has `aria-haspopup="true"`/
  `aria-expanded={open}`; the menu itself has `role="menu"`.
- Fixed three genuinely keyboard-inaccessible controls — not just missing labels, but controls a
  keyboard/screen-reader user could not activate at all, since they were `onClick` handlers on a
  plain `<div>`/`<h2>`/`<span>` rather than a real `<button>`: the Missing page's per-series
  disclosure toggle, the Recycle Bin's per-type disclosure toggle, and Media Detail's per-season
  episode disclosure toggle. All three are now real `<button>`s with `aria-expanded`, visually
  unchanged (background/border/padding reset inline) but keyboard-operable and correctly announced.
- Added `aria-label`s to icon-only buttons that had none: the sidebar/dashboard-widget reorder
  ↑/↓ buttons and the library group delete "✕" button (the sidebar's own "☰" and "⚙" toggles
  already had a `title`, so weren't touched).
- Added a "Skip to main content" link — off-screen until keyboard-focused, the first focusable
  element on every page — so a keyboard/screen-reader user can jump past the sidebar/topbar nav
  instead of tabbing through every nav link on every single page.
- **Known gap, deliberately out of scope this round**: `<label>` elements across the app (~193
  instances) are visually adjacent to their `<input>` but not explicitly associated via
  `htmlFor`/`id` — a screen reader can't reliably tell which label goes with which field. Fixing
  this properly requires touching each of ~193 sites individually (generating a stable id per
  field, many inside `.map()` loops needing a per-iteration id) — a mechanical sweep at that scale
  risked more from rushed/inconsistent edits than it was worth in one pass. Flagging as known
  follow-up work rather than claiming it's fixed.
- Verified live in-browser: confirmed initial modal focus lands on the first real field (not the
  close button) after the fix, confirmed Escape closes the modal, confirmed the DropdownMenu's
  `aria-haspopup`/`aria-expanded` attributes are present and toggle correctly, and confirmed the
  skip link and its `#main-content` target both exist and are wired correctly.

## Round 119 — real-time queue updates (Server-Sent Events)
- The Activity page's queue table used to poll every 10s. Added a Server-Sent Events channel
  (`GET /api/activity/stream`) that pushes a lightweight "queue changed" signal the moment a grab,
  progress update, import, retry, stall-cleanup, priority change, or removal happens anywhere in
  the app — the page re-fetches its existing `/activity/queue`/`/activity/timeline` endpoints
  immediately on that signal instead of waiting for the next poll tick. The 10s poll is kept as a
  30s fallback safety net (a proxy that blocks/buffers `text/event-stream`, or a dropped connection
  EventSource's own auto-reconnect doesn't catch), not removed outright.
- Chose SSE over a WebSocket specifically because it needed zero HTTP-server restructuring — it's
  just another Express route, unlike `ws`, which would require rebuilding `index.ts` around
  `http.createServer`+`WebSocketServer` instead of a plain `app.listen()`. Round 114's `app.ts`/
  `index.ts` split (originally done for testability) made this a clean addition either way.
- New `server/src/services/realtime.ts`: a small SSE client registry plus a throttled
  `notifyQueueChanged()` (coalesced to at most one broadcast per 1.5s) — deliberately a "something
  changed, go re-fetch" signal rather than trying to stream hand-serialized row diffs from the
  9 different call sites that mutate the `queue` table (routes/media.ts, routes/search.ts,
  services/scheduler.ts's `grab()` — the single choke point shared by manual/auto-search, retries,
  and bulk-search/auto-upgrade — services/importer.ts, and routes/activity.ts itself).
- Found and fixed a real auth gap while wiring the frontend: an `EventSource` can't set the
  `X-Api-Key`/`X-Session-Token` headers the rest of the app's auth relies on, so the browser client
  passes whichever credential the session actually has as a query param instead. `requireAuth`
  already had a query-param fallback for the instance API key (`?apikey=`) but NOT for session
  tokens — meaning an admin logged in normally via username/password (session token, not the
  instance API key) would have silently gotten no live updates at all, only the fallback poll.
  Added the matching `?sessionToken=` fallback in `middleware/auth.ts`.
- Verified live against both SQLite and Postgres: opened the Activity page in-browser (confirmed
  via network inspection that the SSE connection opens with `?sessionToken=` for a normal logged-in
  admin session), inserted a queue row, deleted it through the now-instrumented `DELETE
  /activity/queue/:id` route, and confirmed the page's queue table updated to "Nothing in the
  queue" with no reload/manual refresh — genuine live push, not a coincidental poll tick — on both
  dialects.

## Round 118 — scheduled duplicate detection with notification
- The duplicate-merge tool (Round 107) was manual-only — an admin had to remember to check the
  Duplicates page. Added a daily scheduled job ("Duplicate Check", 5am, admin-configurable/run-now
  via the existing Jobs page — registering it in `services/jobRegistry.ts` gets those controls for
  free, no frontend changes needed) that runs the same `findDuplicateGroups()` sweep and sends a
  notification through whichever channels are already configured (Discord/Slack/webhook/Telegram/
  Pushover/...) when it finds a group that hasn't been notified about before.
- New `duplicate_group_seen` table gates re-notification: a still-unmerged duplicate group keeps
  showing on the Duplicates page (unchanged — that page is deliberately a live, stateless sweep,
  merging is the only thing that actually resolves a duplicate) but won't notify again on every
  daily run, only the first time it's seen. `DuplicateGroup` now carries a stable `key`
  (`type::normalizedTitle::year`) used as that identity.
- New `notifyDuplicatesFound(count, sampleTitles)` in `services/notifications.ts`, following the
  exact same template/fanOut pattern as the existing `notifyGrabbed`/`notifyImported`/`notifyFailed`
  — no new notification-channel plumbing needed, just one more thin wrapper.
- Verified live against both SQLite and Postgres: seeded a duplicate pair via the API, ran the job
  via `POST /api/jobs/duplicateCheck/run`, confirmed the "1 new duplicate group(s) found" log line
  on the first run and confirmed a second run produced no further log/notification — identical
  behavior on both dialects.

## Round 117 — health page: config-completeness warnings, historical indexer stats
- Extended (rather than duplicated) the existing System → Health tab: it already covered live
  reachability/disk-space/stuck-queue checks, but assumed the instance was already configured and
  had no way to tell an admin "you never actually finished setup" once the onboarding checklist was
  dismissed. `GET /api/system/health` now also returns `configWarnings` — flags no root folder, no
  enabled indexer, and no enabled download client — rendered as a red banner at the top of the tab.
- Wired Round 116's new per-indexer historical success-rate data (`indexer_health`) into the same
  endpoint: the indexer table's existing "Status" column (a live reachability check) now sits next
  to a "Recent success rate" column ("92% (50) · 340ms" style, with the last error on hover) — an
  indexer can pass a live check while having failed most of its last 50 real searches, which the
  old live-only check had no way to surface.
- Verified live against both SQLite and Postgres: confirmed all three config warnings fire on a
  fresh, fully-unconfigured instance, confirmed adding a root folder makes exactly that one warning
  disappear (the other two persist correctly), and confirmed a test indexer's live/historical
  health both render correctly and identically on both dialects.

## Round 116 — per-indexer health tracking
- Added Sonarr/Radarr-style per-indexer health tracking: every real search attempt through
  `searchIndexer()` — manual "Search", scheduled auto-search, the wanted-list cycle, and the
  Indexers page's own "Test" button, every call site funneled through this one choke point — now
  records success/failure, response time, and the error (if any) to a new rolling `indexer_health`
  table, pruned to the most recent 50 attempts per indexer.
- The Indexers page now shows a "Health" column: success rate + check count + average response
  time (e.g. "92% (50) · 340ms avg"), colored green/red by rate, with the last error as a hover
  tooltip on a failing indexer — surfaces a dying indexer immediately instead of it silently
  contributing nothing to search results until someone notices.
- New `server/src/services/indexerHealth.ts`: `recordIndexerHealth()` (best-effort, never throws —
  a health-logging failure can't mask the real search result/error) and `attachIndexerHealth()`
  (one grouped query for the whole indexer list, mirroring Round 111's `attachChildCounts()`
  pattern rather than one query per indexer).
- Verified live against both SQLite and Postgres: created an indexer pointed at a URL that
  reliably 404s, ran the "Test" button and confirmed the health summary (success rate, avg
  response time, last error) appeared correctly and identically on both dialects; bulk-inserted 60
  health rows directly and confirmed pruning correctly capped the table at 50 rows for that
  indexer.

## Round 115 — mobile-responsive layout pass (item #4 of the scoped improvement list)
- Found and fixed a real, app-wide mobile bug: `.content` (a flex child of `.app`) has no
  `min-width: 0`, so it defaults to `min-width: auto` — meaning it never shrinks below the
  intrinsic width of whatever's inside it (a toolbar row, a table), forcing the whole `.app` wider
  than the viewport instead of letting the sidebar+content fit. Measured directly on a 375px-wide
  viewport: sidebar (220px, fixed) + content (317px, refusing to shrink) = 537px, causing
  page-wide horizontal scroll on every single page in the app. One-line fix (`min-width: 0` on
  `.content`) plus a `overflow-x: auto` safety net so any page with an unusually wide table/row
  scrolls internally instead of forcing the layout wider again in the future.
- The sidebar now defaults to collapsed on a first visit from a narrow (≤768px) viewport — a fixed
  220px column left almost no room for content on a phone-sized screen otherwise. This only affects
  a device's *first* visit (no saved preference yet); an existing collapsed/expanded choice is
  never overridden. While expanded on a narrow viewport, the sidebar renders as a full-screen
  overlay (`position: fixed; inset: 0`) instead of squeezing content into a ~150px sliver next to
  it, dismissed the same way it's opened.
- Bumped the sidebar's mobile "☰" show/hide toggle from a ~28px tap target to a proper 40×40px one.
- Reduced `.content`'s padding on screens ≤640px (28px/36px down to 16px) so more of a small
  screen's width goes to actual content.
- Verified live in-browser at a 375×812 mobile viewport (with Chrome/Android UA emulation) across
  Dashboard, Settings, and the Movies library (both poster-grid and list/table views, both the
  sidebar and top-bar nav layouts): confirmed zero horizontal overflow on every page checked
  (`window.innerWidth` now genuinely matches the viewport, versus 537px of forced overflow before
  the fix), the sidebar auto-collapses on a fresh mobile visit and opens as a full-screen overlay,
  and re-verified desktop (1280px) is completely unaffected — sidebar still defaults expanded, no
  overflow, existing behavior unchanged.

## Round 114 — automated test suite (item #1 of the scoped improvement list)
- Added a real automated test suite (vitest + supertest) for the server, starting with the highest-
  risk paths per the earlier scoping note: the duplicate-merge tool (`services/duplicateCheck.ts`)
  and the pagination/filtering work from Round 113 (`GET /api/media`, `GET /api/media/stats`).
  Deliberately not aiming for full coverage in one round — this establishes the harness and pattern
  for tests to keep accumulating against, same as this session's own manual practice of verifying
  everything against real backends rather than mocks.
- Split `server/src/index.ts` into `src/app.ts` (a `createApp()` that does all DB/settings/route
  init and returns the Express app, but never calls `.listen()` or starts the cron scheduler) and a
  now-thin `index.ts` that just calls `createApp()` then listens — this is what makes the routes
  actually testable with supertest without a real running server or background jobs firing during
  tests. No behavior change for production; same init order, same listen call.
- New `server/tests/helpers/testDb.ts`: gives every test file a real, fully-isolated database —
  SQLite gets a fresh temp-dir file per test file; Postgres (when `AONARR_DATABASE_DRIVER=postgres`
  is set, e.g. in CI) gets its `public` schema dropped and recreated before that file's app startup
  runs, so the normal schema-create + default-seed path runs against a genuinely clean database
  every time, matching first-boot production behavior exactly.
- New GitHub Actions workflow (`.github/workflows/server-tests.yml`, only in this branch/PR — not
  something Claude Code can trigger) runs typecheck plus the full test suite against BOTH a fresh
  SQLite file and a live Postgres service container on every push/PR touching `server/**`, so future
  rounds get automatic dual-dialect regression coverage instead of relying solely on manual `docker
  compose` verification.
- A real dialect bug was caught while building this: one of the new tests used SQLite-only
  `datetime('now')` in a raw INSERT, which failed against Postgres with `function datetime(unknown)
  does not exist` — fixed by using the existing portable `nowExpr(db)` helper instead. The bug was
  in the new test code, not the app itself, but it's exactly the kind of dialect-drift mistake this
  suite exists to catch before it reaches app code.
- Verified live: ran the full 11-test suite via `npm test` inside a Node 20 container (matching the
  Docker image's pinned Node version, since the local host's Node 26 has no prebuilt `better-sqlite3`
  binary yet) against both SQLite and a real Postgres 16 container — all 11 pass on both after the
  `datetime()` fix above.

## Round 113 — server-side library pagination
- Item #2 of the previously-scoped improvement list: `GET /api/media` (the Library page's main
  fetch) now returns `{ items, total }` with real `limit`/`offset`/`sort`/`status`/`contentRating`
  query params instead of a bare array of every item of a type — a large library (thousands of
  albums/books/ROMs) no longer pulls its entire contents into the browser just to show, filter, and
  sort one page of tiles. Sort and every status filter (including "Unmatched") now run as SQL
  conditions server-side; the Library page's local `.filter()`/`.sort()` over the full array is
  gone.
- Added `GET /api/media/stats` — a separate, lightweight aggregate endpoint (item/child totals, the
  distinct content-rating list for the type's filter dropdown) that stays correct independent of
  which page you're viewing, since the header "N have / N missing / N total" badges shouldn't
  change just because you paged forward.
- Added Prev/Next pagination controls to the Library page (60 items/page), shown only when a
  filtered result set actually exceeds one page.
- New shared `server/src/services/mediaQuery.ts` builds the WHERE/ORDER BY/params once for both the
  list and stats routes, so they can't silently drift on what counts as "in scope" (type/tag/group
  scoping, the per-user content-rating restriction, household `allowedTypes`).
- Known, intentional behavior change: "Select all" (the bulk-select toolbar) now selects only the
  current page's items rather than every item matching the current filter across the whole type —
  renamed to "Select all on page" to make the new scope explicit, matching how paginated bulk
  actions work elsewhere.
- Verified live against both SQLite and Postgres: seeded 75 synthetic movies (25 flagged
  downloaded), confirmed page 1/2 boundaries, title-sort ordering, the "Downloaded" status filter
  (25 results, correctly collapsing to zero pagination controls since they fit on one page — caught
  and fixed a real bug here where the pagination math was using the unfiltered stats total instead
  of the filtered list's own total, which showed "Page 1 of 2" for a 25-item filtered result), and
  the "Unmatched" filter (all 75, since none had external ids) — identical results on both dialects.

## Round 112 — "Recently Changed" dashboard widget
- Added a "Recently Changed" Dashboard widget (item #5 of the previously-scoped improvement list):
  a table of the most recent grab/import/auto-archive/subtitle events across the whole library,
  each row linking straight to the affected item. Reuses the existing `history` table (already
  populated by `importer.ts`/`scheduler.ts`/`archival.ts`) rather than adding new tracking — no
  schema change needed.
- New `GET /api/dashboard/recent` (server/src/routes/dashboard.ts): a smaller, household-account-safe
  sibling of `activity.ts`'s admin-only `/timeline` — same `history` join, capped to 15 rows, no
  Requests merged in (this widget is about library content changes, not request activity).
  Filtered by `allowedTypesFor(req)` like every other dashboard endpoint.
- Slots into the existing widget/layout-customization system with no extra wiring — adding the
  `recentlyChanged` entry to `widgetDefs` automatically made it reorderable/hideable/resizable via
  the Dashboard's existing "Customize layout" panel.
- Verified live against both SQLite and Postgres: seeded `history` rows directly (grabbed/imported
  events against the Daft Punk artist added in Round 110's verification), confirmed the widget
  renders the correct title/type/event/timestamp on both dialects and that its row navigates to the
  right media item.

## Round 111 — Starr-style per-item and library download progress
- Added Sonarr/Radarr-style progress to episodic (TV, Anime) and collection (Music, Books,
  Audiobooks, Comics, Manga, Online Videos, Courses) library types: each media tile (poster and
  list view) now shows a progress bar and an "X/Y" count of how many of its episodes/albums/issues
  are actually downloaded versus missing, not just the item-level "has at least one file" badge
  that already existed. "single"-shape types (Movies, ROMs, Adult) are unaffected — one file per
  item means their existing Downloaded/Missing badge is already the full picture.
- Added the same child-level rollup to each library's header stats: alongside the existing
  item-level "N have / N missing / N total" badges, episodic/collection libraries now also show a
  library-wide "N episodes/albums/... downloaded" / "N missing" total — the library-level aggregate
  Sonarr/Radarr both surface, which AoNarr's per-item-only counts couldn't answer before (e.g. "3/10
  episodes" per show doesn't tell you how many episodes are missing across the whole library).
- New shared `attachChildCounts()` (server/src/services/childCounts.ts) computes these via one
  grouped aggregate query per shape (`episodes`/`sub_items`, chunked by 500 ids) rather than one
  query per item, and is attached to every `GET /api/media` response.
- Verified live against both SQLite and Postgres: imported artists via search (Daft Punk/Deezer,
  38 albums; Radiohead/MusicBrainz, 100 albums), confirmed the Music library's poster tiles, list
  view, and header stats all render the correct per-item and library-wide "0/38"/"0/100"/"138
  albums missing" figures on both dialects, and confirmed a single-shape library (Movies) shows
  neither the progress bar nor the child-count header badge.

## Round 110 — music library auto track-matching
- Fixed a real bug: adding an artist (via search or an import list) fetched and created its albums
  but never fetched their tracks, so a newly-added artist's albums sat with an empty track list
  until an admin opened each one and clicked "Fetch tracks" by hand. Both album-creation paths
  (`POST /api/metadata/import`'s eager child-fetch, and the Trakt/IMDb/Last.fm import-list sync's
  `insertArtistAlbums`) now call a new shared `insertTracksForAlbum()` helper for every album that
  has a provider external id, right after its album row is committed.
- Track fetches run *after* the album-insert transaction commits, not inside it — holding a
  Postgres connection open across a whole artist's worth of sequential network calls would have
  blocked other queries needing that same connection for as long as the slowest artist add took.
- Found and fixed two real issues surfaced only by calling this fetch in a tight per-album loop
  (previously it only ran one album at a time, from a manual button click): (1) MusicBrainz's
  fetch calls had no timeout, so a single stalled request could hang an entire artist's import
  indefinitely — added a 10s `AbortSignal.timeout` to the MusicBrainz and Deezer track-fetch
  requests; (2) MusicBrainz enforces roughly 1 request/second and this loop was issuing 2 requests
  per album back-to-back with no pause, producing a wall of HTTP 503s partway through any
  multi-album artist — added a ~1.1s pause between MusicBrainz album fetches. A single album's
  fetch failure (unsupported provider, timeout, rate limit) is still best-effort and doesn't block
  the rest of the artist's albums or the add itself.
- Verified live against both SQLite and Postgres backends: imported "Daft Punk" via the Deezer
  provider on each, confirmed all 38 albums were created and all 266 of their tracks were
  automatically populated with no manual "Fetch tracks" click, on both dialects identically. Also
  confirmed against MusicBrainz (via a large-discography artist) that the new timeout aborts
  cleanly instead of hanging, and that a run of provider errors no longer stalls the request.

## Round 109 — top-bar nav layout, dashboard widget resizing
- Added a top-bar layout as an alternative to the left sidebar, toggled per-browser from the same
  "Layout options" panel Round 108 added: Library and the admin-only Manage/Configuration/System
  sections render as click-to-open dropdowns instead of the sidebar's inline accordion, since a
  horizontal bar has no room to expand a section in place. The section reorder/hide customization
  from Round 108 applies to both layouts — the same saved order/visibility, just rendered
  differently depending on which one is active.
- Added per-widget sizing to the Dashboard's "Customize layout" panel: each widget can be set to
  full-width or half-width, with two half-width widgets sitting side by side (collapsing back to
  one column under 900px so a half-width table/grid never gets squeezed unreadable). Extended the
  shared layout-customization hook with a `sizes` map alongside the existing order/hidden state.
- Fixed a real bug caught while building the top-bar layout's own settings panel: embedding the
  reorder/hide/resize controls inside the existing `DropdownMenu` component closed the whole menu
  on the *first* click inside it (checkbox, ↑/↓ button, or select), since that component closes on
  any click bubbling up from its contents — fine for a menu of one-shot actions, unusable for a
  multi-step settings panel. Built a plain toggle + positioned panel for this one case instead,
  confirmed live that clicking a reorder button now keeps the panel open.
- Verified live in-browser: switching to the top bar renders correctly (dropdowns open, Library
  shows every media type, admin groups show their links) and switching back to the sidebar is
  clean; a reorder click inside the top bar's settings panel applies immediately without closing
  it; two widgets set to half-width render side by side and a reload keeps both the layout mode
  and the widget sizes.

## Round 108 — UI polish: layout bugs, layout options, metadata merge
- Fixed a real navigation bug: switching from a grouped library (Online Videos, ROMs, Adult) to a
  flat one (Music, Movies, ...) left the previous type's group state sitting around, so the flat
  library's page kept showing the old type's group in its breadcrumb (e.g. "Music / Youtube" after
  visiting Online Videos → Youtube then navigating to Music) — confirmed via a real client-side
  navigation, not just a fresh page load, which is what the bug actually required to reproduce.
- Fixed the per-library "on disk" size figure: switching libraries quickly could let an earlier,
  slower-to-resolve request overwrite a later, faster one's correct size — the page would show
  whichever library's request happened to finish last, not necessarily the one being viewed.
- Fixed several button/input misalignments on the Activity, Settings, and System pages where a
  button sat visibly lower than its row-mates (an input, a label, or another cell in the same
  table row) — all traced to the same cause: the default button's `margin-top: 16px` (meant for a
  button following a stacked label+input) leaking into flex rows that were never meant to have it.
- Fixed select/dropdown text reading as cut off by the arrow: widened the reserved arrow padding
  and added ellipsis truncation so a select that's narrower than its longest option now shows
  "..." instead of a letter just vanishing at the box edge; also stopped toolbar buttons/selects
  from being flex-compressed below their own content width before wrapping to a new line.
- Added a side-by-side metadata-merge tool to the media detail page: fetch from 2+ providers, then
  pick which source (current value or any fetched provider) to use per field — poster/title/year/
  overview — and apply the merged result in one PATCH. Added `year` to the item PATCH endpoint's
  supported fields, needed for the merge to actually apply a picked year.
- Added layout customization, saved per-browser: the Dashboard's widgets (Library Size, Recently
  Added, Recently Watched, Upcoming) can now be reordered and hidden via a "Customize layout"
  panel; the sidebar's admin-only sections (Manage, Configuration, System) can be reordered and
  hidden the same way; the whole sidebar can be collapsed to reclaim screen width, with a floating
  toggle to bring it back. Also widened the library poster-size picker from 3 sizes to 5
  (X-small/Small/Medium/Large/X-large).
- Verified live against both Postgres and SQLite (the `year` PATCH field) and in-browser against
  SQLite: the breadcrumb fix confirmed via an actual client-side sidebar-link navigation (not a
  fresh page load, which wouldn't have reproduced the bug); the metadata-merge tool confirmed
  end-to-end with real MusicBrainz/Deezer fetches, picking a mixed poster+year combination and
  confirming the applied result matched exactly; the dashboard/sidebar customization confirmed
  persisting across a reload.

## Round 107 — add a duplicate-merge tool
- New "Duplicates" page (System nav group) for cleaning up the duplicate rows that predate Round
  106's import-matching fix, or anything else that ends up looking like a duplicate later: sweeps
  the whole library for items sharing an exact (normalized title, year), lets an admin pick which
  one to keep per group, and merges the rest into it in one click.
- Merging adopts the file/metadata the keeper is missing from whichever duplicate has it,
  reassigns everything meaningful pointing at the removed rows instead of silently losing it to
  cascade-delete — episodes/sub-items (skipping anything that would collide with what the keeper
  already has), tags, collection membership, grab history, the active download queue, blocklist
  entries, watch status, share links, and household requests. A colliding child or an unadopted
  extra file is left alone by default; check "Recycle files that aren't kept" to send those to the
  Recycle Bin instead of leaving them on disk untracked.
- New `GET /api/duplicates` and `POST /api/duplicates/merge` endpoints; the tag/collection-
  membership reassign uses the same dialect-conditional `INSERT ... ON CONFLICT`/`INSERT OR IGNORE`
  pattern established for other upsert-shaped writes, since both have a composite primary key a
  loser and keeper could collide on.
- Verified live against both Postgres and SQLite: a 3-way movie duplicate (one with a file, two
  without) merges to one row with the file and a tag from a different duplicate both preserved; a
  TV show duplicate with an overlapping episode keeps the keeper's copy and still picks up the
  loser's non-overlapping episode; two duplicates sharing the identical tag merge without a
  constraint error on either backend.

## Round 106 — fix movie import duplicates (#10)
- Fixed #10: movies (and only movies/ROMs/Adult — the "single" shape) could get duplicated by
  every import path (Scan & Import, and Plex/Jellyfin/Emby/Radarr media-server import) because
  each one matched a candidate file/item against *only currently-missing* movies (`has_file = 0`)
  instead of every movie of that type — the same title/episodic/collection import paths already
  matched against everything, this was the one place that didn't. Once a movie had a file, it
  became invisible to future matching, so a second copy, a re-scan, or a later media-server sync
  seeing the same movie again always created a brand new row instead of recognizing it.
  Newly-created movies were also never added back to the in-memory list a scan matches new files
  against, so two files for the same brand-new movie in one scan (a sample + the real file, two
  quality variants) each created their own row too.
- Now matches against every movie of the type regardless of file status; a match on an
  already-has-a-file movie is recognized (not duplicated) without overwriting its existing file —
  the extra file is left on disk and reported in the scan's skip log instead. Audited every other
  import path (import lists, watchlist CSV import, Starr's Lidarr/Readarr collection import, Add
  Media search) for the same class of bug — all of them already matched correctly (by external id,
  or via a fresh per-item duplicate check), this was isolated to the two single-shape paths.
- Existing duplicate rows from before this fix aren't automatically merged — use the Library page's
  multi-select "Remove" action (added in Round 103) to manually clean those up.
- Verified live against both Postgres and SQLite: two files for one new movie in one scan now
  create exactly one row; a later scan/import seeing an already-imported movie again also stays at
  one row, with its original file path preserved.

## Round 105 — surface why Scan & Import skips files, retry flaky ffprobe reads
- Scan & Import previously logged only a bare `skipped: N` count with no indication of which
  files were skipped or why — a file with an unparseable filename, wrong folder depth, or outside
  every root folder simply vanished from view with nothing to diagnose. Every skip site now
  records a specific reason (e.g. "couldn't guess a title from the filename", "sits directly in
  the root folder with no parent folder"), and both the manual scan-import route and the scheduled
  library-scan job log each skipped file's path and reason (capped at 20 per run so a systemic
  naming mismatch across hundreds of files doesn't flood the log).
- `probeMediaInfo` (ffprobe) now retries once, after a short delay, when the failure looks like a
  transient read issue ("moov atom not found", "invalid data found", "could not find codec
  parameters") rather than a genuinely corrupt file — these are the exact errors a network-mounted
  file (NFS/SMB share, a cache-to-array move still settling) throws when read mid-flux by one
  process while playing back fine moments later in another. A file that fails identically on both
  attempts is still reported as unprobed (never blocks the import itself, unchanged from before).
- Verified live: an unparseable filename now logs its exact path and reason instead of a silent
  count; a file that fails ffprobe still imports correctly with `has_file` set, matching the
  existing "probe failure never blocks import" behavior.

## Round 104 — fix AllDebrid grabs failing on every .torrent-byte upload
- Fixed #1 (reopened): every grab that resolved to raw `.torrent` bytes (rather than a magnet URI)
  was silently treated as "AllDebrid rejected the magnet," even when AllDebrid had accepted it
  fine — `/magnet/upload/file`'s response nests its result under `data.files[]`, not
  `data.magnets[]` like `/magnet/upload` does, and the code always read `magnets[]` regardless of
  which endpoint was actually called. This was the follow-up bug behind "the error has changed"
  after the earlier redirect/torrent-bytes resolution fix: that fix correctly started resolving
  proxy URLs to real magnets/torrent bytes and reaching AllDebrid successfully, but then
  misparsed the file-upload response and reported a false failure on every one.
- Verified against a local mock AllDebrid API server matching the documented response shapes for
  both `/magnet/upload` (redirect-to-magnet case) and `/magnet/upload/file` (raw torrent-bytes
  case, the actual bug) — both now report their grab as completed.

## Round 103 — GitHub issue fixes: music tracks/artwork, bulk remove, manga chapters
- Fixed #9 (no track data): Scan & Import never created individual `tracks` rows for a Music
  album folder, only the album-level has_file/file_path — the album detail page showed "0 have /
  0 total, no track data available" forever even with every file on disk. Now parses a track
  number/title per file during scan (same "01 - Song" convention the download-import path already
  assumed) and upserts a `tracks` row for each one, via a portable `ON CONFLICT ... DO UPDATE` that
  works unchanged on both SQLite and Postgres. Added a startup backfill
  (`backfillMissingAlbumTracks()`) so already-scanned albums self-heal on the next restart instead
  of needing a full library re-scan (which wouldn't have picked them up anyway — known album
  folders are skipped on re-scan).
- Fixed #7 (no artist poster artwork): MusicBrainz — the default artist metadata provider, kept
  for its authoritative id — never returns artist artwork at all, so every scan-imported/refreshed
  artist stayed posterless regardless of which of Discogs/Last.fm keys were configured. Now
  opportunistically backfills a MusicBrainz result's missing poster from Deezer's public,
  keyless API by name match.
- Implemented #8 (album artwork): added a `poster_url` column to `sub_items`; Deezer/Discogs/
  Last.fm album-listing fetches now capture cover art automatically when an artist is added via
  search or an import list; added a manual "click to add/change cover art" affordance (Library
  page's album table and the album detail page) for scan-imported albums or any provider that
  doesn't have art.
- Added #6 (bulk remove): a `POST /media/bulk/delete` endpoint and a "Remove" button in the
  Library page's multi-select toolbar, alongside the existing Monitor/Unmonitor/Search actions —
  supports the same untrack-only vs. also-delete-files choice as the single-item delete.
- Investigated #5 (manga management): the media type, search providers, and frontend nav already
  existed, but manga's default provider (AniList) has no per-chapter listing API, so every manga
  added through the normal flow sat at "0 total" chapters forever — the same class of gap as #9.
  Added a MangaDex chapter-feed fetcher and switched manga's default provider to MangaDex (which
  has one), matching how Comics already defaults to ComicVine for the same reason.
- Verified live against both a real Postgres 16 container and SQLite: scan-imported a multi-track
  album and confirmed all tracks appear with correct numbers/titles; confirmed the startup backfill
  recovers a previously-scanned album's tracks after clearing them; confirmed a MusicBrainz artist
  search result gets backfilled with a real Deezer poster; confirmed manual and automatic album
  artwork both persist; confirmed bulk delete removes multiple items in one call; confirmed adding
  a manga via MangaDex populates a full real chapter list.

## Round 102 — PostgreSQL migration complete
- Converted the last 3 files: `services/scheduler.ts` (auto-search/grab, queue polling, stalled-
  download cleanup, retry logic, video-channel checks), `routes/search.ts` (manual/bulk search and
  grab), and `services/scheduledBackup.ts` — **all 80 files converted**, `AONARR_DATABASE_DRIVER=
  postgres` now runs the complete app
- Designed and implemented real per-dialect database backup/restore, closing the one deferred
  design question from earlier rounds: SQLite keeps `better-sqlite3`'s own backup API; Postgres now
  uses `pg_dump --format=custom`/`pg_restore --clean --if-exists`, shared between the scheduled
  backup job and the manual `/system/backup`/`/system/backup/restore` routes
- Added `postgresql-client-17` (from the official PGDG apt repo, not Debian bookworm's own v15
  package) to both Docker images — a same-version client refuses to dump servers newer than itself,
  which is now the common case
- Fixed a live-discovered `pg_restore` compatibility issue: `--single-transaction` aborted an entire
  restore over one cosmetic `SET transaction_timeout` statement unsupported on older servers;
  dropped the flag and added targeted error-inspection so a restore that only skipped that one
  harmless statement is correctly reported as successful
- Added `nowOffsetHoursExpr()` for `cleanupStalledDownloads()`'s hour-granularity threshold
- Verified live against a real Postgres 16 container (deliberately one version behind the Postgres
  17 client, to actually exercise the compatibility fix): manual/bulk search and grab, and a full
  backup → mutate → restore roundtrip with a real downloaded dump file — regression-checked against
  SQLite, including a full backup/restore roundtrip there too

## Round 101
- PostgreSQL support: converted `routes/media.ts` — the largest remaining file (~40 routes: item
  CRUD, tags, bulk monitor/tag, CSV export/import, metadata export, corrupt-file check, rematch,
  watch-state, episodes, sub-items/tracks, yt-dlp direct download) — 77 files converted so far, 3
  remain
- Converted `bulk/monitor` and `bulk/tag`'s better-sqlite3 synchronous transaction-closure pattern to
  the async `db.transaction(async () => {...})` pattern used since Round 90
- Converted 2 `INSERT OR IGNORE` call sites (`media_item_tags`) to the dialect-conditional
  `ON CONFLICT DO NOTHING` pattern
- Verified live against a real Postgres container: full CRUD across movie/series/artist shapes, tags
  (single-item and bulk), episodes, sub-items, watch-state, and CSV export — same sequence
  regression-checked against SQLite

## Round 100
- PostgreSQL support: converted `routes/system.ts` (`/network-stats`, `/status`, `/health`,
  `/orphaned-scan`) — 76 files converted so far, 4 remain
- `/backup` and `/backup/restore` deliberately stay on the raw SQLite handle (`Database.backup()`,
  file-swap restore) — no Postgres equivalent exists yet, tracked as the same open design question as
  `services/scheduledBackup.ts`
- Fixed a camelCase SQL alias (`AS totalBytes` → `AS "totalBytes"`) in `/network-stats` that would
  have silently folded to lowercase and broken the JSON response under Postgres
- Added `nowOffsetHoursExpr()` next to the existing day-granularity `nowOffsetExpr()` for `/health`'s
  6-hour stuck-queue threshold
- Verified live against a real Postgres container: a stuck queue item and a low-disk-space sample
  correctly surfaced in `/system/health`'s warnings, cross-checked against `/metrics`'s Prometheus
  counters — same sequence regression-checked against SQLite, including a real backup download

## Round 99
- PostgreSQL support: converted `routes/importLists.ts`, `routes/metrics.ts`,
  `services/starrImport.ts` (Radarr/Sonarr/Lidarr/Readarr library migration), and
  `services/importer.ts` (post-download file placement/manual import) — 75 files converted so far, 5
  remain
- Fixed `routes/metrics.ts`'s Prometheus counters to wrap raw `pg`-driver `COUNT(*)` string results
  in `Number(...)` so they render as real numeric metric values instead of string literals
- Verified live against a real Postgres container: import-list CRUD, the Prometheus metrics scrape,
  and an end-to-end manual movie import (file move, has_file/path/quality update, history row) — same
  sequence regression-checked against SQLite on the same build

## Round 98
- PostgreSQL support: converted `services/mediaServerImport.ts` (Plex/Jellyfin/Emby movie + series
  library import), `services/importLists.ts` (Trakt/IMDb/Last.fm list syncing), and
  `services/libraryScan.ts` (filesystem scan-and-import for movies, episodic shows, and
  collection/artist items, including the has_file rollup and concurrency lock) — 71 files converted
  so far, 9 remain
- Fixed one call site in `services/starrImport.ts` to await the now-async `defaultQualityProfileId()`,
  without converting the rest of that file
- Widened `insertSeriesEpisodes()`/`insertArtistAlbums()`'s `mediaItemId` parameter type in
  `importLists.ts` to accept `null`, matching the async DB driver's nullable `lastInsertRowid`
- Verified live against a real Postgres container: TV episode, music album track, and movie file
  scan-imports all correctly matched/created their `media_items` rows with the right has_file rollups
  and child rows (`episodes`/`sub_items`) — same sequence regression-checked against SQLite on the
  same build

## Round 97
- PostgreSQL support: converted `services/traktSync.ts`, `routes/metadata.ts`,
  `services/recommendations.ts`, and `routes/watchlistImport.ts` — 68 files converted so far, 12 remain
- `routes/metadata.ts`'s `/import` route had 3 better-sqlite3-style synchronous
  `db.transaction(fn)(rows)` calls (episode/album/child batch inserts) — converted to the async
  transaction pattern established in earlier rounds
- Closed a small ordering gap: `queueForReview()` in the watchlist-import "not found" path is now
  correctly `await`-ed inline instead of fire-and-forget
- Verified live against a real Postgres container: manual media import including the
  transaction-based child-episode insert, Trakt sync's no-op-when-unconfigured path,
  recommendations' DB-backed queries running cleanly ahead of the key-gated external API calls, and
  watchlist import's full duplicate-skip → not-found → import-review-queue flow — same sequence
  regression-checked against SQLite on the same build

## Round 96
- PostgreSQL support: converted `services/storageForecast.ts`, `services/duplicates.ts`,
  `services/upgradeCandidates.ts`, and `services/cleanupSuggestions.ts` (the first Tier 1 batch of a
  newly-written conversion plan for the remaining files) — 64 files converted so far, 16 remain
- **Found and fixed a serious, previously-latent Postgres bug unrelated to this migration's own async
  conversion work**: the schema translation mapped SQLite's `INTEGER` (already 64-bit) to Postgres's
  `INTEGER` (32-bit, max ~2.1GB) literally for 4 byte-count columns — `queue.size`,
  `recycle_bin.size_bytes`, `disk_usage_samples.free_bytes`/`total_bytes`. Any real download or file
  over ~2GB (a routine 4K remux) would silently overflow on every Postgres deployment doing real
  downloads. Caught live when disk-usage sampling failed against a real ~1TB test filesystem. Fixed
  the fresh-install schema (`BIGINT` on all 4 columns) and added a startup migration that safely
  widens existing installs' columns on next restart, verified to correctly recover real data with no
  loss and to be idempotent across repeated restarts
- Quoted several more unquoted camelCase SQL aliases found along the way
- Verified live against a real Postgres container: simulated an existing pre-fix install, confirmed
  the predicted overflow error, then confirmed the startup migration fixes it; exercised disk usage
  sampling (a real ~1TB value that would have overflowed pre-fix), repeated-import detection,
  upgrade-candidate detection, and both cleanup-suggestion routes end to end — same sequence
  regression-checked against SQLite, where this bug class doesn't exist at all

## Round 95
- PostgreSQL support: converted `services/customFormatScoring.ts` (deferred since Round 85 as
  "called from deep within the search/grab pipeline") — 60 files converted so far, 20 remain
- Its 2 call sites (`routes/search.ts`'s manual-search annotation, `services/scheduler.ts`'s
  `chooseBestResult()`) turned out to be the same tractable shape Round 93 found repeatedly: a plain
  synchronous `.map()` callback, fixed with the same `Promise.all(items.map(async ...))`
  restructuring already used twice last round
- Verified live end to end against SQLite with a real search (not mocked): created a movie, a custom
  format matching a release title pattern, a scored quality profile, and a local mock RSS indexer,
  then confirmed a real manual search correctly returned the configured `formatScore`/`formatMatches`
- Postgres verification this round was necessarily lighter: `search.ts`/`scheduler.ts` (both still
  unconverted) read what a search needs through the Round 80 shadow-SQLite path, so a live
  end-to-end search can't be driven from outside the app under Postgres the way it can under
  SQLite's single database — `scoreRelease()`'s own queries are unchanged from already
  Postgres-verified patterns from Round 85, and typecheck + the alias-risk grep both passed clean

## Round 94 — GitHub issue fixes + Soulseek support
- **Fixed #1 — AllDebrid grabs failing with "Magnet is not valid"**: the `alldebrid` client passed
  an indexer's raw Torznab "get"/proxy `downloadUrl` straight to AllDebrid's magnet-upload endpoint
  instead of resolving it first. Added a shared `resolveDownloadSource()` helper that follows a
  redirect to a real `magnet:` URI (fetch can't follow a redirect to a non-http(s) scheme itself,
  so this is done by hand with `redirect: "manual"`) or reads raw `.torrent` bytes when the proxy
  serves the file directly instead of redirecting; `.torrent` bytes now upload via AllDebrid's
  multipart `/magnet/upload/file` endpoint rather than the URI endpoint. Also fixed the same latent
  issue in the `realdebrid` client, which had the same "not every proxy URL is a magnet" gap.
  Verified against a local mock server covering direct magnet, single/multi-hop redirect-to-magnet,
  and raw `.torrent` bytes.
- **Fixed #2 — duplicate TV shows after scanning**: `POST /media/scan-import` had no guard against
  two overlapping scans of the same type — a scheduled "Library Import" job firing while a manual
  scan (or a duplicate click) was still in flight would race, both loading their own snapshot of
  existing shows before either had inserted anything, both concluding "no match" for the same new
  series, and both inserting their own duplicate row. `probeMediaInfo`'s per-file ffprobe subprocess
  call is slow enough that this was an easy real-world race, not just a theoretical window. Fixed
  with an in-process per-type lock in `scanAndImportLibrary` — a second overlapping call for the
  same type now skips instead of racing. Verified live by firing two concurrent scan-import requests
  against the same library type and confirming no duplicate rows resulted.
- **Fixed #3 — TV shows shown as "Missing" despite having every episode**: the Library page's
  "Missing" badge reads `hasFile` on the top-level media_items row, but `scanAndImportLibrary`'s
  episodic/collection branches only ever set `has_file` on the *child* episode/sub_item row they
  matched or created — never rolling it up to the parent series/collection, unlike
  `mediaServerImport.ts`/`starrImport.ts`'s import paths, which already did this correctly. Added
  the same rollup (`UPDATE media_items SET has_file = 1 WHERE ... id IN (SELECT DISTINCT
  media_item_id FROM episodes/sub_items WHERE has_file = 1)`) to Scan & Import, plus a one-time
  startup backfill (`backfillEpisodicAndCollectionHasFile()`, safe to run unconditionally on every
  boot — each UPDATE is a no-op once already-fixed) so existing installs' already-affected shows get
  corrected without needing a fresh re-scan. Verified live: scanned in a two-episode show and
  confirmed `hasFile` flipped to `true` on the parent series row.
- **Added #4 — Soulseek (via slskd) as a download client**: Soulseek has no Torznab indexer and no
  real "download URL" — files are only (username, remote filename) pairs from Soulseek's own
  search. Added a `slskd` download client type (host/port/API key, same shape as qBittorrent/
  SABnzbd — a real external client AoNarr tracks progress on, not a debrid-style pull-to-self
  client) plus `services/soulseek.ts`, which queries a configured slskd daemon's own search API
  directly for Music-library searches and encodes each result's (username, filename, size) into a
  `slskd://` pseudo-URI riding through AoNarr's existing "grab posts a downloadUrl back" contract
  unchanged — no changes needed to the indexer/scheduler pipeline itself. Verified the URL encode/
  decode round-trip and the search-response parsing against a local mock slskd server (covering
  multiple peers, a peer with no free upload slot, and Windows-style remote paths); verified live
  that creating a client, its host/port validation, and the search route's graceful failure when
  slskd is unreachable all work correctly end to end.

## Round 93
- PostgreSQL support: converted `services/blocklist.ts`, `services/rootFolderSelect.ts`,
  `services/releaseGroupStats.ts`, `services/duplicateCheck.ts`, and `services/importExclusions.ts` —
  59 files converted so far, 21 remain
- Corrected an overly pessimistic assessment from Round 92: re-checked every one of these 5 services'
  ~25 call sites individually instead of assuming from their role in "the pipeline," and found only 2
  genuinely needed control-flow restructuring — the rest were plain `for` loops or values computed
  before a `.map()`, trivially `await`-able with no surrounding rewrite
- Restructured `scheduler.ts`'s `chooseBestResult()`: `getGroupReputation()` was called directly
  inside a `.sort()` comparator (which can't `await`) — fixed by precomputing every release group's
  reputation into a `Map` before sorting, then doing synchronous lookups in the comparator
- Restructured `recommendations.ts`'s exclusion filter (`isExcluded()` as an `Array.filter()`
  predicate) with a small local `filterAsync()` helper
- Updated every other call site (in `search.ts`, `media.ts`, `metadata.ts`, `watchlistImport.ts`,
  `importLists.ts`, `traktSync.ts`, `importer.ts`, `scheduler.ts`, `system.ts`) with just `await` —
  without converting those files' own other database calls, the same surgical pattern Round 90 used
- Verified live against a real Postgres container: blocklist-grab rejection, duplicate-detection 409s,
  root-folder auto-select, and per-group release stats all work correctly; ruled out an unrelated
  pre-existing bug (adding media with a root folder 500s under Postgres, reproducing even with an
  explicit `rootFolderId`) as the known "`media.ts` still writes to the orphaned shadow SQLite"
  Round 80 caveat, not something introduced this round — confirmed working correctly on SQLite, where
  there's no database split — full flow regression-checked against SQLite on the same build

## Round 92
- PostgreSQL support: converted `services/mediaAnalysis.ts` + `routes/mediaAnalysis.ts` (the Library
  Analysis page) — 54 files converted so far, 26 remain
- Found and fixed a real, pre-existing bug unrelated to database portability: the episodes query in
  `getLibraryAnalysis()` never selected `e.media_item_id`, but its row mapper read it anyway — every
  episode analysis item's `mediaItemId` was silently `undefined` in the API response, on both
  backends, since this feature shipped
- Documented why the remaining 26 files (the media-add pipeline and the search/grab/scoring pipeline)
  don't decompose into further small batches: their helper functions are called inline from
  synchronous `.filter()`/`.sort()`/`.some()` predicates in the big route/service files, not from
  simple `await`-able call sites — converting them needs restructuring the surrounding control flow,
  not just adding `await`
- Verified live against a real Postgres container: seeded real `media_info` JSON and confirmed the
  instant analysis route's summary and the episode mediaItemId fix, then generated a real playable
  file with `ffmpeg` and ran the full-library re-probe job against it with real `ffprobe`, confirming
  the result correctly persisted via the new async UPDATE — regression-checked against SQLite on the
  same build

## Round 91
- PostgreSQL support: converted `routes/settings.ts` (instance settings, API key regen, TOTP 2FA,
  config-template export/import) and `services/importReview.ts` + `routes/importReview.ts` — 52 files
  converted so far, ~18 remain
- Found and fixed a real, pre-existing bug that affected SQLite too, not just Postgres: several
  `settings.ts` routes wrote the `settings` table via raw SQL instead of `setSetting()`, silently
  bypassing the in-memory settings cache `requireAuth` reads on every request. In practice this meant
  a freshly regenerated API key didn't work until the next server restart, and disabling TOTP 2FA
  didn't take effect until restart either. Fixed by routing every settings write through
  `setSetting()`/a new `deleteSetting()`, and added `getAllSettings()` so reads use the cache too
- Found and fixed a genuine SQL portability bug: `queueForReview()`'s dedup check used SQLite's
  `col IS ?` null-safe-equality-with-a-parameter syntax, which is a straight syntax error on Postgres
  (its `IS` only accepts literal `NULL`/`TRUE`/`FALSE`). Fixed with the standard-SQL
  `IS NOT DISTINCT FROM`, which both backends support with identical semantics
- Verified live against a real Postgres container: confirmed both settings bugs existed pre-fix and
  are gone post-fix (immediate API-key and TOTP-disable effect, no restart needed), a full
  config-template export → import → export round-trip, and the import-review queue's list/counts/
  resolve/dismiss routes — same sequence regression-checked against SQLite, where the pre-fix bugs
  reproduced identically before the fix resolved them there too

## Round 90
- PostgreSQL support: converted the recycle-bin/corrupt-media cluster deferred since Round 86/88 —
  `services/recycleBin.ts` + `routes/recycleBin.ts`, `services/corruptMediaCheck.ts` +
  `routes/corruptMediaReview.ts`, and `services/archival.ts` (auto-archival) — 49 files converted so
  far, ~21 remain
- Unblocked by recognizing the only thing standing in the way was `recycleFile()`'s 3 call sites in
  the still-unconverted `routes/media.ts`, all already inside `async` handlers — adding `await` to
  those 3 lines was enough to convert the whole cluster without touching `media.ts`'s own (much
  larger) set of database calls
- `recycleBin.ts`'s scheduled-purge query was one of the 5 files flagged in the original SQL-
  portability audit for SQLite's `datetime('now', ?)` syntax — now using the `nowOffsetExpr()` helper
  added in Round 86
- Verified live against a real Postgres container: full delete-with-recycle → restore → re-delete →
  purge lifecycle through `media.ts`'s converted call sites, confirming the file actually moves and
  moves back on disk each time, plus the corrupt-media-review confirm/dismiss routes — same sequence
  regression-checked against SQLite on the same build

## Round 89
- PostgreSQL support: converted `services/push.ts` + `routes/push.ts`, `services/mediaServerWebhook.ts`
  + `routes/mediaServerWebhook.ts`, `services/libraryValidation.ts`, and `routes/requests.ts` to the
  async DB interface — 44 files converted so far, ~26 remain
- Confirmed `sendPush()`'s existing callers already treated it as a Promise before converting its DB
  calls to genuinely async, avoiding the "unconverted caller doesn't await" risk that's blocked
  several other small services in recent rounds
- Replaced two inline `datetime('now')` UPDATEs in `requests.ts` with the `nowExpr(db)` helper, and
  proactively applied `Number(...)` to two more `COUNT(*)` results per the established Round 84/86
  aggregate-as-string bug class
- Verified live against a real Postgres container: round-tripped a push subscription, confirmed a
  Jellyfin-style watch webhook resolved to a seeded media item and immediately appeared in the
  already-converted dashboard (a genuine cross-file check), and exercised the full request lifecycle
  including auto-approval's named-parameter insert and per-user storage stats — same sequence
  regression-checked against SQLite on the same build

## Round 88
- PostgreSQL support: converted `routes/activity.ts`, `routes/calendarFeed.ts` (both the admin token
  router and public `.ics` feed), `routes/dashboard.ts`, `routes/subtitles.ts`, and `routes/wanted.ts`
  to the async DB interface — 38 files converted so far, ~32 remain
- Quoted a large batch of unquoted camelCase SQL aliases, especially in `wanted.ts` and
  `calendarFeed.ts`'s hand-built multi-column SELECTs — same bug class as every prior round
- Proactively wrapped `dashboard.ts`'s `COUNT(*) AS count` in `Number(...)` before verification could
  catch it live, since Postgres returning aggregates as strings is now an established bug class from
  Round 84/86
- Surveyed and deliberately left `metrics.ts`, `metadata.ts`, and `watchlistImport.ts` unconverted —
  all three call into services used by the still-unconverted media-add/search pipeline; that cluster
  (duplicate/exclusion checks, media creation, `media.ts` itself) is better tackled as one dedicated
  round than piecemeal
- Verified live against a real Postgres container: dashboard counts came back as real numbers (not
  Postgres's string-typed `COUNT` result), the full activity queue lifecycle including its "no
  download client" 400 path, wanted/missing and calendar views with all aliased columns intact, and
  the calendar token + public `.ics` feed including its 401-on-wrong-token path — same sequence
  regression-checked against SQLite on the same build

## Round 87
- PostgreSQL support: converted `routes/blocklist.ts`, `routes/importExclusions.ts` (CRUD route
  only), `routes/artwork.ts`, `routes/librarySearch.ts`, and `routes/shareLinks.ts` to the async DB
  interface — 33 files converted so far, ~37 remain
- Found and fixed a real cross-dialect behavior difference: SQLite's `LIKE` is case-insensitive for
  ASCII by default, Postgres's is case-sensitive. `librarySearch.ts`'s global search now uses a
  dialect-conditional operator (`ILIKE` on Postgres) so search results stay identical across both
  backends instead of Postgres silently missing case-mismatched matches
- Quoted several more unquoted camelCase SQL aliases across this batch (same bug class as Round 80),
  including in a `UNION ALL` query where only the first branch's aliases needed it
- Deliberately left several small services unconverted (`blocklist.ts`, `importExclusions.ts`,
  `releaseGroupStats.ts`, `rootFolderSelect.ts`, `duplicateCheck.ts` services, plus
  `storageForecast.ts`/`duplicates.ts`) — all are called synchronously from the still-unconverted
  search/import pipeline or from `system.ts`/`scheduler.ts`, so converting them now would leave those
  callers unawaited on Postgres
- Verified live against a real Postgres container: case-insensitive search in both directions,
  artwork selection, full blocklist/import-exclusion/share-link CRUD (including the public
  token-based share fetch) — same sequence regression-checked against SQLite on the same build

## Round 86
- PostgreSQL support: converted `routes/collections.ts` (all 9 routes, including its smart-filter
  query builder and item-reorder transaction) and `routes/tracks.ts` (both routes) to the async DB
  interface — 28 files converted so far, ~42 remain
- Added `nowOffsetExpr(db, days)` to the async DB layer for SQLite's `datetime('now', ?)` relative-
  offset syntax (used by `collections.ts`'s "added in the last N days" smart filter) — translates to
  Postgres interval arithmetic; 4 more files flagged in the original SQL-portability audit can reuse
  it when they're converted
- Found and fixed two more instances of known migration bug classes: an unquoted `AS itemCount` SQL
  alias (Postgres folds it to lowercase, same class as Round 80's bug) and an un-coerced `COUNT(...)`
  aggregate read as a raw driver value (Postgres returns bigints as strings, same class as Round 84's
  `libraryGroups.ts` fix)
- Found a genuine Postgres incompatibility (not just a folding/type issue): SQLite's `INSERT OR
  IGNORE` has no Postgres equivalent at all. Fixed `collections.ts`'s add-item route with a dialect-
  conditional statement; `media.ts` has 2 more call sites using the same syntax for later
- Deliberately left `recycleBin.ts` (route + service) and `corruptMediaReview.ts` +
  `corruptMediaCheck.ts` unconverted — `recycleFile()` is called synchronously from 3 sites in the
  still-unconverted 947-line `media.ts` plus one in `archival.ts`; converting it now would leave those
  unawaited on Postgres. Deferred to a future round bundled with `media.ts`/`archival.ts`
- Verified live against a real Postgres container: full collection CRUD, item add/dedupe via `ON
  CONFLICT DO NOTHING`, reorder, `m3u`/`json` export (including the skip-fileless-item path), a smart
  collection's `addedAfterDays` filter, and both track routes — same sequence regression-checked
  against SQLite on the same build

## Round 85
- PostgreSQL support: converted `routes/customFormats.ts` (all 8 routes) and its backing
  `services/trashSync.ts` to the async DB interface — 26 files converted so far, ~44 remain
- The scores upsert route (`PUT /custom-formats/scores/:qualityProfileId/:customFormatId`) uses
  `ON CONFLICT ... DO UPDATE` — ported unchanged, Postgres supports the same upsert syntax
- Deliberately left `services/customFormatScoring.ts` unconverted — it's called from the actual
  search/grab pipeline (search, importer, upgrade candidates, scheduler), a much larger and riskier
  surface than custom-formats CRUD; confirmed nothing converted this round calls into it
- Verified live against a real Postgres container: created/renamed/deleted a custom format, set and
  re-read a quality-profile format score, and ran a real `trash-sync` against the live TRaSH-Guides
  GitHub repo (234 Radarr formats synced, 8 unsupported) — same sequence regression-checked against
  SQLite on the same build with identical results

## Round 84
- PostgreSQL support: converted `people.ts`, `calendarEvents.ts`, `libraryViews.ts`,
  `remoteInstances.ts`, `friendLibraries.ts` (route + service), and `libraryGroups.ts` to the async
  DB interface — 24 files converted so far, ~46 remain
- `libraryGroups.ts` carries the app's `WITH RECURSIVE` query (the nested-group item-count rollup)
  — ported with no changes beyond the standard `await` treatment, no new translation gaps found
- Verified live against a real Postgres container: custom calendar events, a saved library view, a
  remote instance, a friend library, and a two-level library group hierarchy — including confirming
  the recursive-CTE count rollup, breadcrumb resolution, and deepest-level detection all work
  correctly — with the same sequence regression-checked against SQLite on the same build

## Round 83
- PostgreSQL support: converted `indexers.ts`, `downloadClients.ts`, and `prowlarrSync.ts` to the
  async DB interface — 18 files converted so far, ~52 remain
- Extended the async DB layer to support better-sqlite3's named-parameter binding style
  (`.run({ name: "x", ... })` against SQL with `@name` tokens), used in 6 files for longer INSERTs —
  Postgres's driver only supports positional `$1, $2, ...` params, so this translates automatically
  rather than requiring every such query to be rewritten
- Found and fixed a real, pre-existing bug (surfaced by testing more thoroughly, not caused by this
  migration): `indexers.ts`'s PATCH route bound boolean fields (`enabled`, `useFlareSolverr`)
  without coercing them to 1/0 first. Both better-sqlite3 and Postgres reject a raw boolean bound to
  an INTEGER column, so `PATCH /indexers/:id` with `{"enabled": true}` would have thrown on either
  backend — nothing had tested that exact input before. Also fixed `downloadClients.ts`'s create
  route, which used `b.enabled ?? 1` (silently wrong specifically for an explicit `enabled: false`,
  since `??` doesn't treat real `false` as nullish)
- Verified live against a real Postgres container: full CRUD on indexers and download clients
  including the named-parameter inserts and the boolean edge cases on both create and patch, plus
  `prowlarr-sync` failing gracefully when unconfigured. Regression-checked the identical sequence —
  including the exact payloads that had been broken — against SQLite on the same build

## Round 82
- PostgreSQL support: converted the quality/library config slice (`tags.ts`, `rootFolders.ts`,
  `qualities.ts`, `qualityProfiles.ts`, `services/quality.ts`) to the async DB interface — 15 files
  converted so far, ~55 remain
- Found and fixed a critical gap: first-boot seeding (default qualities, the default "Any" quality
  profile, and — the one that actually matters — generating the instance API key) only ever existed
  for SQLite. **A fresh Postgres-backed install would have had no API key generated at all — nobody
  could have authenticated into it, not even to reach initial setup.** Added `db/postgresSeed.ts` to
  close this, and silenced a confusing side effect it surfaced along the way: the old SQLite-only
  seeding still runs even in postgres mode (every not-yet-converted file importing `db/client.ts`
  directly triggers it) and was printing its own "generated API key" banner for a key that lives in
  an orphaned, unused shadow database — actively misleading rather than just redundant. Suppressed
  specifically in postgres mode
- Verified live against a real Postgres container with a **completely fresh database and no
  admin-bootstrap env vars set** — the realistic case for most Postgres users — confirming exactly
  one (correct) API key gets generated and logged, qualities/quality-profile seeding works, and
  every converted route (including the quality-reorder transaction's negative-rank staging trick)
  behaves correctly, with the same sequence regression-checked against SQLite on the same build

## Round 81
- PostgreSQL support: converted `routes/users.ts` (household account management — create/list/patch
  users, per-user library permissions, session listing and force-revocation) to the async DB
  interface, the natural next slice after Round 80's auth/login path since it's the other half of
  "who can log in and what can they see." 10 files converted so far; ~60 remain
- Verified live against a real Postgres container: created a household user with library
  permissions, listed users, patched permissions (including the delete-then-reinsert pattern for
  changing allowed libraries), logged in as that user, listed active sessions, force-revoked one,
  deleted the user, and confirmed every one of those actions recorded correctly in the audit log —
  all passed, plus the same sequence regression-checked against SQLite on the same build

## Round 80
- PostgreSQL support: converted the first real vertical slice of the app — the entire auth/login/
  session path (`db/index.ts` new driver dispatcher, `settingsStore.ts`, `auth.ts`,
  `middleware/auth.ts`, `bootstrapAdmin.ts`, `authRoutes.ts`, `audit.ts`, `auditLog.ts`) — to the
  async DB interface from Round 79. **`AONARR_DATABASE_DRIVER=postgres` now boots a real, working
  app for this slice**, the first round that's been true; most of the app (~61 files) still isn't
  converted and would still misbehave under Postgres today
- Kept `getSetting`/`setSetting` and `logAuditEvent` synchronous on purpose (an in-memory cache for
  settings, fire-and-forget writes for both) specifically to avoid cascading `await` through the 24
  files/101 call sites that read settings and the ~20 that log audit events — a deliberate, scoped
  exception to "convert everything," justified by both being small, read-heavy, low-write tables
  where the old synchronous-in-effect behavior is easy to preserve without threading async through
  code that has nothing else to do with the DB
- Found and fixed two real bugs the Postgres verification pass caught that plain `tsc -b` couldn't:
  (1) a converted file calling into a not-yet-converted one (`logAuditEvent`, before this round)
  silently wrote to an orphaned shadow SQLite database instead of Postgres, crashing every login on
  a foreign-key violation — invisible until actually tested against Postgres; (2) Postgres folds
  unquoted SQL identifiers to lowercase, so `auditLog.ts`'s `user_id AS userId` alias came back as
  `userid` on Postgres while working fine on SQLite — every camelCase alias needs explicit quoting
  going forward, documented in DATABASE_MIGRATION.md as a systemic risk for the rest of the
  conversion, not just this one file
- Also fixed a latent bug this conversion surfaced in `routes/users.ts`: `res.json(listActiveSessions())`
  was passing a Promise straight to `res.json()` without awaiting it — TypeScript never flagged this
  because `res.json(x: any)` doesn't care what `x` used to be
- Verified live end-to-end against a real `postgres:16` container on the same build as the SQLite
  regression check: setup-status, admin bootstrap from env vars, login, session-validated requests,
  logout, session revocation, a rejected bad-password login, and the audit log correctly recording
  all of it — all passed on both backends

## Round 79
- Started PostgreSQL support (MariaDB deferred to a later phase per user decision — see
  DATABASE_MIGRATION.md). This round is foundation only: **the running app is unaffected and still
  only runs against SQLite** — nothing in this round is wired into any route yet
- Added `server/src/db/asyncDb.ts` — a dual-dialect async DB interface (SQLite and PostgreSQL) that
  the ~70 route/service files touching data will be converted to use, file by file, in future
  rounds. Callers keep writing plain `?` positional parameters and reading `.lastInsertRowid` off
  `.run()`'s result on both backends — the wrapper handles placeholder translation and Postgres's
  lack of a native rowid (via `RETURNING id`, applied automatically to every INSERT except the
  handful of tables that don't have a plain `id` column, which needed a static exception list after
  a first attempt discovered blindly appending it can poison an in-progress Postgres transaction)
- Added `schema.postgres.sql` (mechanical translation of the existing SQLite schema — only two real
  substitutions needed, `AUTOINCREMENT`→`SERIAL` and `datetime('now')`→an explicit UTC-text
  equivalent) and `postgresSchema.ts` (applies it plus a Postgres port of every existing
  `ensureColumn` retrofit, using Postgres's native `ADD COLUMN IF NOT EXISTS` instead of SQLite's
  introspect-then-ALTER workaround)
- Verified against a real `postgres:16` container (not mocked): full schema migration including an
  idempotent second run, insert/select/update/delete, the `ON CONFLICT ... DO UPDATE` upsert pattern
  used throughout the codebase (ported verbatim, confirmed no duplication on a repeat upsert),
  transaction commit and rollback, and the codebase's one `WITH RECURSIVE` query — all passed
- Updated DATABASE_MIGRATION.md with what actually happened vs. what was originally scoped —
  notably, ended up hand-writing a thin async wrapper instead of adopting Kysely as originally
  recommended, once the SQL-portability audit showed how much of the existing raw SQL already
  ports to Postgres unchanged

## Round 78
- No code changes — scoped the deferred "external database support" (MariaDB/PostgreSQL as an
  alternative to SQLite) request instead of implementing it, per the user's explicit choice to defer
  it until everything else in the original batch shipped. Wrote
  [DATABASE_MIGRATION.md](DATABASE_MIGRATION.md): a concrete accounting of what it would actually
  touch (70 files, 444 `db.prepare()` call sites, a fully-synchronous DB layer with no existing
  abstraction, 48 accumulated ad-hoc SQLite migrations, several SQLite-only SQL constructs in active
  use), the options considered (a multi-dialect query builder vs. a full ORM vs. hand-writing every
  query three times vs. not doing live dual-backend support at all), a recommendation (Kysely,
  Postgres before MariaDB, phased so the abstraction layer lands and stabilizes against SQLite
  itself before a second engine is introduced), and the decision the user still needs to make before
  work starts (commit to the size of this, and whether Postgres-only is an acceptable scope cut).
  Linked from README.md's Architecture section

## Round 77
- Rebuilt the Calendar page as a real month grid — the same view Sonarr/Radarr/Lidarr/Readarr each
  show by default — with Prev/Next/Today navigation, a day cell per date showing up to 3 entries
  plus a "+N more," and a click-through detail panel for the selected day. The previous scrolling
  day-by-day list is still there as an "Agenda" mode (useful for a quick scan of what's coming),
  just no longer the only option
- Closed a real gap in what the calendar could show: it only ever pulled from episode air dates and
  album/book release dates, so movies never appeared on it at all — there was nowhere in the
  schema to even put a movie's release date. Added a `release_date` column to media_items (populated
  from TMDB's own release date on search-select, rematch, and Refresh, the same three moments
  title/overview/poster already get filled in) and wired it into the calendar query — this is the
  same per-type date source each real Starr app's own calendar uses: Sonarr → episode air date,
  Radarr → movie release date, Lidarr/Readarr → album/book release date
- Added custom calendar dates — "+ Add custom date" on the Calendar page lets an admin mark any day
  with a title and optional note (a watch party, a reminder, anything), shown alongside the regular
  entries with a 📌 marker and removable from the day's detail panel. Included in the .ics
  subscription feed too, not just the in-app view
- Verified live: seeded a movie/episode/album all dated today plus a custom event, confirmed all
  four appear correctly in the month grid's today cell (including the "+1 more" overflow), confirmed
  clicking the day opens the detail panel, confirmed removing the custom event actually removes it,
  confirmed Agenda mode still works, and confirmed the movie shows up in the .ics feed

## Round 76
- Added saved, reusable library views — a "Views" dropdown plus "Save view..."/"Delete view" on
  every library page lets you name and reuse a specific combination of sort, status filter, tag
  filter, content-rating filter, poster/list mode, poster size, and visible columns (e.g. "4K
  Missing"), instead of only ever remembering your last-used state (the existing per-browser
  localStorage behavior from Round 64, which this doesn't replace — applying a saved view still
  updates that same local "last used" state). Saved instance-wide, the same sharing model as
  quality profiles and custom formats, rather than locked to one browser; saving/deleting is
  admin-only, viewing/applying isn't
- Added an "Unmatched" status filter to every library page — items with no external provider ids at
  all (almost always a Scan & Import guess or a manual add that's never been searched/refreshed),
  so a library can be filtered down to exactly the items still waiting on a real metadata match
  instead of hunting for them by eye
- Verified live: created a matched and an unmatched movie, confirmed the Unmatched filter shows
  only the right one; created a saved view via the API, confirmed selecting it in the browser
  correctly switched every one of its settings (including actually flipping poster view to list
  view), confirmed "Save view..." and "Delete view" both work end-to-end in the browser

## Round 75
- Added an option to review corrupted media before it's recycled (Settings → Recycle Bin →
  "Corrupt media") — previously the corrupt-media check (ffprobe validation, weekly by default)
  always recycled and marked-missing anything it flagged, fully automatically. With review turned
  on, a flagged file is instead held in a new "Pending Corrupt Media Review" queue at the top of
  the Recycle Bin page — the item keeps showing as present in the library, the file stays exactly
  where it was, until an admin either confirms it (Recycle — runs the exact same recycle-and-
  mark-missing logic the automatic path always used) or dismisses it (false positive — a network
  hiccup, a file that was still being written when checked; leaves everything untouched). Off by
  default, so upgrading changes nothing for anyone who hasn't turned it on
- Verified live: a genuinely unreadable file correctly landed in the review queue (not recycled)
  with the item still showing has_file, confirming Recycle from the queue correctly recycles and
  marks it missing, confirming Dismiss correctly leaves the file and item alone, and confirming both
  actions render correctly and log to the Audit Log

## Round 74
- Fixed Recycle Bin restore freezing the whole app for however long a large file took to move.
  Restoring used `fs.copyFileSync` (needed when the recycle bin and the original location are on
  different Docker volumes — a plain rename fails with EXDEV there) synchronously on the request
  thread, which blocks Node's single event loop for the entire copy — not just that one request,
  every request the server was handling. Restore is now fire-and-forget like every other slow job
  in this app, using real async file I/O (`fs.promises`) so the event loop stays free while a big
  file moves. New `restoring`/`restoreError` columns track progress so the Recycle Bin page can
  show "Restoring..." on the affected row (disabling that row's buttons) and poll until it either
  disappears (done) or shows a retryable error, instead of the button just doing nothing for a long
  stretch. Purging an entry that's mid-restore is now rejected with a clear error instead of racing
  the in-flight move
- Fixed a real title-accuracy bug: the "Refresh" button (and the scheduled Library Refresh job)
  re-pulled overview/poster/year from each item's metadata provider but deliberately never touched
  `title` — meaning an item Scan & Import created from a guessed filename (its whole point being "no
  rich metadata yet") kept that guessed title forever, even after Refresh had already found and
  applied the correct overview/poster/year from the real match. Refresh now also corrects title/
  external ids, but only for items with no external ids yet — i.e. items that were never actually
  matched to real metadata in the first place. An item that's already matched (has external ids)
  keeps its title exactly as-is, since a fuzzy title-only search could occasionally land on the
  wrong result and this shouldn't silently rename something already correct
- Verified both live: the title fix was confirmed with a real (unmocked) AniList lookup — a
  guessed-title unmatched item got corrected to AniList's real title/casing/overview/external id,
  while a deliberately custom-titled already-matched item was correctly left untouched by the same
  Refresh run

## Round 73
- Add Media's "Import from a course page URL" (Round 70) now auto-selects the Courses library's
  "Site" group from the scraped URL's hostname (coursera.org/udemy.com/edx.org → Coursera/Udemy/
  edX) instead of leaving the group picker on "Select Site..." — finds the existing group by name
  if one's already there, creates it on first use otherwise, so scraping several courses from the
  same platform doesn't mean re-picking (or worse, duplicating) the same Site every time
- Widened `pathTail`'s cross-mount-point file-matching heuristic (used throughout media-server
  sync/import and Starr-app import) from the last two path segments to the last three. Two segments
  alone can collide across two *different* shows when episodes are generically named ("Season 01/
  S01E01.mkv" under a season folder with no show name in the filename) — this is exactly what
  produced a false-positive collision in a Round 67 test fixture, previously written off as an
  accepted tradeoff. The third segment reaches up to the item's own folder name (the show, or a
  movie's release folder), which is what actually disambiguates one item from another; a
  mount-point prefix difference never touches these trailing segments, so this is strictly more
  specific than before with no loss of legitimate matches — confirmed with a standalone test script
  covering the exact Round 67 collision (no longer collides), ordinary cross-mount-point movie and
  season-folder episode matches (still match), two different movies sharing everything but their
  own folder name (still don't match), and a shallow 2-segment path with no season folder (unchanged
  behavior, since `slice(-3)` degrades gracefully on shorter paths)
- Verified live: fetching two different Coursera course URLs correctly reused the same "Coursera"
  group (confirmed via the API — no duplicate created) and the group picker's Site dropdown showed
  it pre-selected in the browser both times

## Round 72
- Extended the Audit Log to cover 9 more event types beyond its existing login/request/user/media
  coverage: user permission changes (auto-approve, allowed libraries, max pending requests, max
  content rating — one combined `user_permissions_changed` entry summarizing whatever actually
  changed), force-logging-out a session, enabling/disabling two-factor auth, regenerating the API
  key, downloading a database backup, and adding/removing an indexer or download client. These are
  the security- and administratively-significant actions that weren't attributed to anyone before —
  Audit Log's own scope (who changed account/security/config state) is deliberately kept distinct
  from the existing History page (which already covers grabs/imports/upgrades), so this doesn't
  duplicate that
- Database restore is deliberately NOT logged to the audit table: a restore replaces the entire DB
  file, audit_log included, so an entry written just before the swap wouldn't exist in whatever
  database anyone actually looks at afterward — logged to the server log instead, which is a
  separate, durable store the restore doesn't touch
- Centralized the `auditActor` helper (session user, or "admin" for a bare-API-key request) into
  `services/audit.ts` — it previously lived only in media.ts's own file; now every route file adding
  audit coverage shares one definition instead of copy-pasting it
- Pagination and add/delete/rematch media coverage were already in place from an earlier round of
  this project; this round's news is entirely the additional event types above
- Verified live: exercised all 9 new actions end-to-end (real TOTP setup/verify/disable with a
  correctly-computed code, not a stub) against a running instance, confirmed each produced exactly
  the expected audit_log row with an accurate detail string, and confirmed the Audit Log page
  renders each with its new human-readable label

## Round 71
- Added "Import from Lidarr"/"Import from Readarr" (Music/Books library pages) — extends Round 68's
  Radarr/Sonarr import to the two remaining Starr apps, migrating an already-organized Lidarr artist
  library or Readarr author library into AoNarr. Same one-time-use model as Radarr/Sonarr: URL and
  API key are supplied once in the import dialog and never saved
- Structurally different from movies/series: artists/authors are "collection" shape (an open-ended
  list of albums/books, not a fixed season/episode grid), so this is new matching logic rather than
  a third reuse of Round 68's episodic core — parent matched by external id (MusicBrainz artist id
  for Lidarr; Readarr's Goodreads author id is recorded too, though no existing AoNarr provider key
  overlaps with it yet) then title, child (album/book) matched by path tail then title. An album's
  file_path is its folder (matching how Scan & Import already treats multi-file-per-child music, not
  a specific track), a book's is its one file. Lidarr's own API doesn't return an album's folder
  path, only its track files — derived from the first track file's own directory instead
- Verified live against real mock Lidarr and Readarr servers, mirroring Round 68's three-case matrix
  one level deeper: a pre-existing artist/author matched via external id (artist) or title fallback
  (author, deliberately seeded with no matching id to test that path) with one album/book already
  tracked correctly left untouched and a second created fresh, plus an entirely new artist/author
  created along with its one album/book — confirmed exact counts via the log summary, confirmed the
  resulting database rows including the Readarr author's newly-captured Goodreads id, and confirmed
  "Import from Lidarr"/"Import from Readarr" render correctly on the Music/Books library pages

## Round 70
- Added "Import from a course page URL" (Add Media → Courses) — pulls title/description/thumbnail
  from a Coursera/edX/Udemy (or any) course landing page to prefill the manual Add Media form, the
  last of the deferred items from the original request list. Courses has no metadata-provider API
  (there's no viable public search API for arbitrary course platforms — see mediaTypes.ts), so this
  was previously typing everything in by hand
- Deliberately scoped to Open Graph tags (`og:title`/`og:description`/`og:image`) rather than each
  platform's own internal curriculum/lesson data. During development, Coursera's server-rendered
  HTML did contain a syllabus (an Apollo GraphQL normalized cache blob with week/lecture names),
  but Udemy's didn't expose any curriculum data in its raw HTML at all — its lesson list loads via
  a separate, undocumented internal API call. Building on either would mean silently working for
  one platform and not another, and breaking without warning on the next front-end redesign of
  whichever platform it did work on. Open Graph tags, by contrast, are meant to be publicly scraped
  (that's their purpose — link-preview cards) and were present and stable on all three real pages
  tested. The lesson-by-lesson breakdown still has to be added by hand after creating the entry,
  same as before this round
- Verified live against real Coursera, edX, and Udemy course pages (not mocks) — confirmed correct
  title/overview/poster extraction for each, confirmed edX's " | edX" title suffix and HTML entities
  (`&#x27;` → `'`) are handled, confirmed a friendly error for both an invalid URL and an unreachable
  domain rather than a raw fetch exception, and confirmed the new "Import from a course page URL"
  section on Add Media (Courses only) actually populates the Title/Overview fields end-to-end in
  the browser

## Round 69
- Added "Sync from TRaSH-Guides" (Settings → Quality → Custom Formats) — pulls every custom format
  TRaSH-Guides publishes for Radarr or Sonarr straight from their public GitHub repo and syncs it
  into AoNarr's own custom-format table, closing the "syncing (not just importing)" gap left by the
  existing paste-JSON import: re-running the sync updates formats already pulled in (matched by
  TRaSH's own stable `trash_id`, stored in a new `custom_formats.trash_id` column) rather than
  duplicating them, so it stays current as TRaSH's guides evolve instead of being a one-time copy
- Extracted the specification-to-condition-group translation (title/release-group/size, now also
  resolution — TRaSH's `ResolutionSpecification` uses a plain pixel-height value, not a Radarr/
  Sonarr-internal id, so it's safe to map) into a shared `trashFormats.ts` used by both the sync and
  the existing paste-JSON import, so the two paths can't drift on what counts as translatable.
  Anything else (quality-modifier, language, indexer-flag, source specs — all keyed to Radarr/
  Sonarr's own internal enums) is still reported back as unsupported rather than silently dropped
- Newly-synced formats are scoped to the syncing app's own library types (Radarr → Movies, Sonarr →
  Series/Anime) rather than left unrestricted, since a resolution/size-tier format has no reason to
  also apply to unrelated libraries; a user can broaden the scope afterward like any other format.
  Fire-and-forget, same reasoning as the media-server/Starr-app imports (Rounds 66-68) — fetching
  200+ format files from GitHub can outrun an HTTP/gateway timeout
- Verified live against the real TRaSH-Guides repo (not a mock): synced Sonarr's 236 published
  formats (226 translated and added, 10 correctly reported unsupported), confirmed individual
  translations in the database (e.g. `1080p` → a resolution condition, `x265` → its title-regex
  condition with the internal quality-modifier spec correctly skipped), re-ran the same sync and
  confirmed it reported "added 0, updated 226" with the total format count unchanged (no
  duplication), and confirmed the paste-JSON import still works unchanged (regression check on the
  now-shared translation code) and the new Sync buttons render correctly in Settings

## Round 68
- Added "Import from Radarr"/"Import from Sonarr" (Movies/Series/Anime library pages) — migrates an
  already-organized Radarr or Sonarr library straight into AoNarr, closing the last of the three
  deferred migration paths flagged back in Round 65 (media server was Rounds 66-67; this is "import
  from other Starr programs"). Unlike the media server connection, this isn't a standing setting:
  the Radarr/Sonarr URL and API key are supplied once in the import dialog and used only for that
  one request, never saved, since there's no ongoing reason for AoNarr to keep talking to a
  Radarr/Sonarr instance once its library has been pulled in
- Reuses the exact match-or-create logic already shipped and verified for Plex/Jellyfin/Emby import
  (Rounds 66-67) — refactored `importMoviesFromMediaServer`/`importSeriesFromMediaServer` into
  fetch-then-import pairs so both the media-server path and the new Radarr/Sonarr path share one
  `importMovieItems`/`importSeriesData` core, rather than duplicating the matching precedence (path,
  then external id, then title/year(/season/episode)) a second time
- Sonarr's v3 API has no bulk "every episode" endpoint — episodes and episode-files are fetched
  per-series (N+1 requests), which is fine for a one-time migration but wouldn't be for a repeated
  sync; noted in code rather than treated as something to optimize away in a job that only runs once
  per library
- Verified live against real mock Radarr and Sonarr servers: for movies, three cases (already
  tracked and correctly skipped, tracked under a wrong guessed title with no file and correctly
  matched via its tmdb id, never seen and correctly created) plus a fourth case confirming a movie
  with no file yet in Radarr is correctly excluded entirely rather than imported as empty; for
  series, the same three-case matrix one level deeper (show matched via tvdb id with one episode
  already tracked left untouched and its sibling episode created fresh, a second show created along
  with both its episodes) — confirmed exact match/create counts via the log summary, confirmed the
  resulting rows in the database, and confirmed the "Import from Radarr"/"Import from Sonarr"
  buttons and modals render with the correct app name and copy on both library types

## Round 67
- Extended "Import from Media Server" (Round 66, movies-only) to TV Shows and Anime libraries —
  the deferred "larger job" from last round: matching/creating individual episodes under the right
  parent show, not just a flat list of files. Fetches every show and every episode from the
  configured Plex/Jellyfin/Emby server in two bulk passes (all shows, then all episodes), joins
  episodes to their parent show in memory via Plex's `grandparentRatingKey` or Jellyfin/Emby's
  `SeriesId`, then for each show matches or creates the AoNarr media_item (by external id, then
  title+year — same precedence as the movie importer) and for each of its episodes matches or
  creates the episode row by season+episode number, filling in has_file/file_path/title/overview
  from the media server's own data. A show's own has_file flag is set once any of its episodes has
  a file, matching how every other import path already treats episodic items
- "Import from Media Server" button and modal (built in Round 66) now also appear on the Series and
  Anime library pages, with type-aware copy describing the show/episode matching precedence
- Verified live end-to-end against a real mock Plex TV server with three cases: a show and episode
  AoNarr already had tracked (correctly skipped, left untouched), a show AoNarr knew under the
  wrong guessed title with one episode already tracked (correctly matched via tmdb id rather than
  duplicated, existing episode left alone, its other episodes created fresh with real Plex
  metadata), and a show AoNarr had never seen at all (correctly created along with all its
  episodes) — confirmed exact expected counts via the structured log summary, confirmed the
  resulting media_items/episodes rows in the database, and confirmed the button/modal render
  correctly on the Series library page in the browser. (First test pass used file paths that
  happened to share a last-two-path-segment across two different shows — e.g. both named
  `Season 01/S01E01.mkv` — which the existing pathTail cross-mount-point matching heuristic
  treated as identical files; this is a known, pre-existing tradeoff already relied on everywhere
  else in the codebase, not a bug, and the fixture was corrected to use distinct filenames.)

## Round 66
- Added "Import from Media Server" (Movies library page, when a media server is configured) —
  pulls an already-organized Plex/Jellyfin/Emby movie library straight into AoNarr with its real
  title/year/overview/poster/external ids, instead of requiring Scan & Import (filename-guessing
  only, no rich metadata) or adding everything one-by-one through Add Media. Matches against
  anything already in AoNarr first — by path, then external id (tmdb/imdb/tvdb), then title+year —
  before falling back to creating a new entry, so a library that's partially already tracked
  doesn't get duplicated
- Required actually extracting the metadata Plex/Jellyfin's APIs already return but the existing
  polling code discarded (it only ever kept path+id, enough for watch-state matching but nothing
  else): Plex's `Guid` array (current agents) and legacy `guid` string (older agents still seen on
  long-running servers that haven't re-matched) for external ids, `summary`/`thumb` for overview/
  poster; Jellyfin/Emby's `ProviderIds`/`Overview`/`ImageTags`. TV shows aren't included this round
  — matching/creating individual episodes under the right parent show is a larger job on its own
- Fire-and-forget the same way Scan & Import already is, for the same reason (fetching and
  matching an entire library can easily outrun an HTTP/gateway timeout)
- Verified live against a real mock Plex server with three deliberately distinct cases in one
  library: a movie already tracked by AoNarr (correctly skipped, left untouched), a movie only
  known to AoNarr under a wrong guessed title with no file (correctly matched via its tmdb id
  rather than duplicated, and filled in with Plex's real overview/path/poster), and a movie AoNarr
  had never seen at all (correctly created fresh with full metadata) — confirmed all three outcomes
  in the actual database afterward, confirmed the poster URL was built correctly with the Plex
  token, and confirmed the "Import from Media Server" button and its root-folder-picker modal
  render correctly in the browser

## Round 65
- Added Plex/Jellyfin/Emby as a notification target (Sonarr/Radarr's "Connect" feature) — a real,
  total gap before this: AoNarr already had polling-based watch-state sync and an incoming webhook
  for Plex/Jellyfin/Emby, but never told the media server about a newly-imported file, so it sat
  invisible until the media server's own scan interval got to it. New opt-in setting ("Refresh
  media server library after each import", off by default so upgrading changes nothing for anyone
  who only has a media server configured for watch-sync). Plex gets a targeted refresh scoped to
  just the new file's folder (`PUT /library/sections/{key}/refresh?path=...`, fired against every
  movie/show section since there's no cheap way to know in advance which one a given path belongs
  to — Plex just no-ops for the wrong ones); Jellyfin/Emby have no equivalent lightweight per-path
  endpoint, so they get a full `POST /Library/Refresh` instead — heavier, but still faster than
  waiting for their own scan interval. Never blocks or fails the import itself — best-effort,
  logged on failure rather than thrown
- Verified live against real mock Plex and Jellyfin servers (not just reading the code): ran a real
  manual import with the setting on, confirmed Plex received the exact expected `GET
  /library/sections` enumeration followed by two `PUT .../refresh?path=<url-encoded-path>` calls
  (one per movie/show section) with the correct destination path; confirmed Jellyfin received a
  `POST /Library/Refresh` with the correct `X-Emby-Token` auth header; confirmed a second import
  with the setting off produced zero additional requests, proving the opt-in gate actually gates

## Round 64
- Added three new sort options (Monitored, Quality, Content rating) and a Content Rating filter
  (dynamically populated from whatever ratings are actually present in the library, same pattern
  the existing Tags filter already uses) to every library's toolbar
- Added column customization to the list view and info-line customization to the poster view —
  previously both were hardcoded (list: Title/Year/Status/Monitored always, no way to add or
  remove any; poster: Year/Status/Monitored always, same). New "Columns" (list view) / "Poster
  info" (poster view) dropdown with a checkbox per available field (Year, Status, Monitored,
  Quality, Content rating, Added date) — pick whichever combination is actually useful for that
  library type. Persists per-browser via localStorage, same as the sort/status/view choices
  Round 59 already made sticky
- Verified live end-to-end: sorted by Quality and confirmed correct alphabetical ordering
  (Bluray-1080p before Remux-2160p); filtered by a specific content rating and confirmed only the
  matching item showed; toggled Quality on in the poster-info picker and confirmed it appeared in
  the poster sub-line without the dropdown closing on each checkbox click; reloaded the page and
  confirmed the poster-field choice persisted; switched to list view and added Quality + Content
  rating columns, confirmed both rendered with correct per-item data

## Round 63
- Added four new custom format condition types, closing most of the gap versus real Sonarr/
  Radarr's condition set: **Source** (Remux/Bluray/WEBDL/WEBRip/HDTV/DVD), **Resolution**
  (2160p/1080p/720p — split out from the combined `quality` string as their own conditions),
  **Year** (min/max range), and **Release Flags** (proper/repack/extended/unrated/directorscut/
  imax — newly parsed from the release title; nothing detected these before). Previously only
  Title/Size/Language/ReleaseGroup existed. New syntax lines in the Custom Formats textarea:
  `SOURCE:`, `RESOLUTION:`, `YEAR:`, `FLAGS:`, alongside the existing `SIZE:`/`LANG:`/`GROUP:`
- Added per-library scoping to custom formats — "Giving the option to set custom format by
  library" was a real, total gap: a custom format applied to every media type indiscriminately
  with no way to restrict it. New `mediaTypes` field (empty = every library, the previous
  behavior, so nothing existing changes); a multi-select per format in the table, and checkboxes
  on the add form. `scoreRelease()` now takes the searching item's type and skips any format
  that's restricted to other types — threaded through all 6 call sites (search route + 5 inside
  the scheduler's auto-search/retry paths)
- Added "Preferred size" to Quality Definitions — previously min/max size only *rejected*
  releases outside a range; there was no way to express "closer to this size wins" between two
  releases that are otherwise tied. Now a genuine tiebreaker: after format score, seeders, and
  release-group reputation, whichever candidate's size is closest to its quality's configured
  preferred size wins. No preferred size configured (the default) is a neutral tie, same as before
- Verified live end-to-end: created a `movie`-scoped "Remux Boost" format and confirmed it scores
  for a movie search but correctly scores 0 for a series search with the identical release title;
  created unrestricted Resolution/Year/ReleaseFlags formats and confirmed correct AND/OR/negate
  behavior across realistic release titles (a clean 2024 4K release matched all three; the same
  release with a PROPER tag correctly lost only the negated "avoid proper/repack" format; an old
  1080p release matched only that one); set a preferred size and confirmed the distance
  calculation correctly favors the closer release; confirmed the per-format media-type multi-select
  round-trips through a real PATCH request in the browser

## Round 62
- Added a per-library enable/disable toggle for naming (Settings → Media → Naming) — previously
  every import always renamed a file via its type's template unconditionally, with no way to keep
  files as originally downloaded. When disabled for a type, the template's folder structure still
  applies (so files stay organized and episodes stay grouped by season — the whole reason renaming
  exists in the first place isn't just cosmetic), only the filename itself is left as-downloaded
  instead of templated. Applies to every shape: single (Movies/ROMs/Adult), episodic (TV/Anime),
  and collection (Books/Comics/etc, and Music's album *folder* specifically — track filenames were
  already always kept as-downloaded there)
- Replaced the naming section's flat list of plain text inputs with a proper "Naming setup..."
  popup per library type: the enable/disable toggle, a template field, buttons that insert the
  tokens actually available for that type's shape at the cursor position, a live preview rendered
  with example values, and a one-click reset to the shape's default — instead of a wall of
  unlabeled tokens in a paragraph above a dozen bare `<input>`s
- Verified live end-to-end: toggled naming off for Movies via the new popup, confirmed the setting
  persisted (`namingEnabledMovie: 0`), then ran a real manual import of a file named
  `My.Weird.Release.Name.2020.1080p.WEB-DL.mkv` — confirmed it landed at
  `Test Naming Disabled Movie (2020)/My.Weird.Release.Name.2020.1080p.WEB-DL.mkv` (templated
  folder, original filename kept exactly). Verified the reverse case too: ROMs (left at its
  untouched default) still fully templates both folder and filename as before

## Round 61
- Added a manual-match fallback for titles Watchlist Import and Import Lists' recurring sync
  couldn't confidently match — previously a "no metadata result found" title (both flows take the
  provider's own top result with no confidence threshold) was silently discarded with no record
  anywhere, a dead end with no way to ever recover it. New Import Review page (nav: Manage → Import
  Review) queues every unmatched title instead, with a "Match..." action reusing the same
  interactive-search flow Add Media already has, and a "Dismiss" action for ones you don't want —
  dismissed titles are deduped against on future syncs so they don't get silently re-queued forever.
  Watchlist Import's results table now links to Import Review when it has unmatched rows; the
  Import Lists page shows a per-list "N need review" badge. New `import_review_items` table;
  Trakt and Last.fm import-list syncs don't do provider-search matching at all (Trakt trusts its
  own tmdb id, Last.fm adds every returned artist), so only Watchlist Import and Import Lists'
  IMDb sync — the two paths that actually have a "no match" branch — feed this queue
- Added a "Browse..." folder picker to the Scheduled Backups directory setting (System → Backups)
  — it was a plain text input with no way to browse the container's filesystem, unlike every other
  path field in the app. Turned out a full directory browser + "New folder" endpoint
  (`/api/system/browse-directory`) and a reusable `FolderPicker` component already existed (used
  for root folders) — this just wires the same component into the one remaining path field that
  didn't have it yet, no new backend needed
- Verified live end-to-end: browsed into a real container directory, created a subfolder, selected
  it, confirmed the setting saved correctly; ran a fake title through Watchlist Import, confirmed
  it appeared in Import Review, resolved it (created the media item, cleared the queue entry), ran
  a second fake title through, dismissed it, and confirmed re-running the same import doesn't
  re-queue the dismissed title

## Round 60
- Added a read-only Media Analyzer (System → Media Analyzer) covering every library — a
  library-wide breakdown (video codec, HDR format, audio codec, resolution, subtitle language
  coverage) plus a per-file table with rule-based playback-compatibility notes for common
  hardware/software gotchas (an AV1 file that needs a fairly recent device to decode, single-layer
  Dolby Vision with no HDR10 fallback, DTS/TrueHD needing an AVR with passthrough, image-based PGS/
  VobSub subtitles that can't be resized or styled, 10-bit color needing Main10 decode support,
  etc.). Nothing here moves, renames, or modifies any media file — ffprobe only ever reads
- Widened what `ffprobe.ts` actually captures to make the analyzer possible: HDR signaling
  (color transfer/primaries/space, bit depth), Dolby Vision detection (reading the DOVI
  configuration record ffprobe surfaces in a stream's side_data_list, with a codec-tag fallback
  for older ffmpeg builds), frame rate, and — a real gap in the old capture — every audio and
  subtitle track instead of just the first of each (a file with a commentary track or 5 dub
  languages only ever showed its first audio stream before this)
- Files imported before this shipped only have the old narrower MediaInfo shape and show as "not
  yet analyzed" until re-probed — added an "Analyze now" action (per-library or everything) that
  re-probes with the new capture and updates the stored data, fire-and-forget the same way Scan &
  Import already is for large libraries
- Verified live end-to-end: generated a real HDR10-tagged HEVC file with ffmpeg (genuine
  `smpte2084`/`bt2020` color metadata, not mocked) and confirmed the analyzer correctly detected
  "HDR10" with accurate compatibility notes; generated a real AV1+FLAC file and confirmed both
  correctly triggered "caution" notes; verified the caution/incompatible filter dropdown narrows
  the table correctly. Dolby Vision's signaling couldn't be reproduced with a genuine encode (it
  needs source RPU metadata a synthetic test clip doesn't have) — verified the detection logic
  instead against 7 cases of realistic mock ffprobe output modeled on documented DV signaling
  conventions (profile 5, profile 8.1 dual-layer, HDR10+, HLG, plain HDR10, plain SDR, and a file
  with no color tags at all), all passing

## Round 59
- Fixed "API Definition fetch error unauthorized" on the API Docs page: Swagger UI's request
  interceptor only ever attached `X-Api-Key`, never `X-Session-Token` — any admin logged in via a
  normal session (not the raw admin API key) sent a fully anonymous request to `/api/openapi.json`
  and got 401'd. Now sends whichever credential the current login actually populated
- Fixed clicking any link/media row landing scrolled partway down the new page instead of at the
  top — a plain `<BrowserRouter>` never resets scroll position on navigation on its own; added a
  small `ScrollToTop` component that does
- Fixed the ffprobe "Invalid data found when processing input" / "EBML header" corrupt-file
  detection being trigger-happy: a single ffprobe failure for *any* reason (a genuinely corrupt
  file, but equally a file still mid-write, a network/SMB mount hiccup, or a brief lock) was
  unconditionally treated as "corrupt, recycle it" with zero retry. Now checks whether the file's
  size is still changing (a dead giveaway it's still being written) before trusting a failure, and
  gives ffprobe one retry a few seconds later before concluding anything is actually broken.
  Verified against both a real corrupt file (garbage bytes saved as `.mkv`, reproducing the exact
  "EBML header parsing failed" error from the bug report — still correctly caught after the retry)
  and a file actively growing mid-write (correctly spared, not flagged corrupt)
- Implemented Scan & Import for "collection"-shape libraries (Music, Books, Audiobooks, Comics,
  Manga, Online Videos, Courses) — previously an intentional stub that always returned "isn't
  supported yet." Follows the same folder-convention approach Sonarr/etc. use: the file's immediate
  parent folder becomes the parent item (Artist/Author/Creator, matched or created), and the child
  (Album/Book/Issue) is either the next folder down for `multiFilePerChild` types like Music (a
  whole album folder becomes one child, matching how normal album grabs already work) or the file's
  own name for everything else. Verified live: scanned a real `Radiohead/OK Computer/*.mp3`
  structure, confirmed "Radiohead" was auto-created and "OK Computer" correctly registered as its
  album; re-ran the scan and confirmed already-known albums are correctly skipped, not re-processed
- Added pagination to the Audit Log (previously a flat unpaginated list capped at 500 rows total,
  no way to see anything older) — `page`/`pageSize` query params server-side, Previous/Next controls
  in the UI, and the effective total no longer capped at all (just paginated)
- Added audit logging for adding, deleting, and rematching media — previously the audit log only
  covered logins/requests/account changes, not the actual library-changing actions most worth
  reviewing later. Verified live: added, rematched, and deleted a test item, confirmed all three
  showed up correctly with the right before/after detail
- Moved the poster-size dropdown into the same toolbar row as Sort/Status/Tags (previously in a
  separate row with View), and made Sort and Status selections persist across visits the same way
  View and poster size already did (all four now save to localStorage) — verified live: changed
  Sort to "Title" and Status to "Missing" on Movies, navigated to a completely different library,
  confirmed both choices carried over
- Added a "Select" toggle to every library's toolbar (previously the bulk-selection checkboxes were
  always visible for every admin, cluttering the view when you're not trying to bulk-act on
  anything) plus "Select all"/"Select none" buttons that appear once selection mode is on. Verified
  live: toggled Select on, confirmed checkboxes appear, confirmed Select all correctly selects every
  currently-visible item

**Scoped for later rounds** — the rest of this request is several genuinely separate large features,
each comparable in scope to a full subsystem (a read-only media analyzer with HDR/Dolby
Vision/hardware-compatibility detection; per-library naming setup UI; fully custom/filterable
sorting across every metadata field; list/poster view column customization; a real per-library
custom-formats + quality-definitions system like Sonarr/Radarr's; Plex/Jellyfin/Emby as
notification *and* library-import targets; importing config/libraries from other Starr apps;
Coursera/edX/Udemy course-page scraping; TRaSH-Guides format *sync* rather than one-time import;
manual-match fallback UI for Watchlist Import and Import Lists; a file-path browser for the backup
directory setting; "search all missing" bulk actions). Tackling these next, starting with whichever
you'd like prioritized first.

## Round 58
- Continued the audit series onto the security-critical files: `auth.ts`, `totp.ts`,
  `rateLimiter.ts`, `middleware/auth.ts`, and `releaseParser.ts` (release-title matching, used
  everywhere search results get matched against wanted episodes). Password hashing, session token
  generation, session expiry enforcement, and rate-limit logic all checked out clean — no fail-open
  paths, no weak entropy sources
- Fixed two non-constant-time credential comparisons: the TOTP code check (`totp.ts`) and the
  instance-wide admin API key check (`middleware/auth.ts`) both used plain `===`/`string` equality
  instead of `crypto.timingSafeEqual`, theoretically leaking per-character timing info about the
  correct value. Practical exploitability was already low given the existing rate limiter's
  10-attempts/15-minute cap, but fixed anyway since it's the credential guarding the highest-privilege
  surface in the app. Applied the same fix to the calendar-feed and media-server-webhook tokens for
  consistency, via a shared `safeEqual()` helper. Verified live: session-token auth, correct and
  wrong API keys (including a same-length wrong guess to actually exercise the constant-time compare
  path rather than the length-mismatch shortcut), and a full TOTP enroll-with-a-real-computed-code
  flow all behave identically to before the fix
- Reviewed TOTP replay protection (a code can be reused within its ~90s validity window) and decided
  not to implement it this round — doing so properly requires threading per-user identity through
  five call sites plus a schema change, for a narrow attack window that requires an attacker to
  already be intercepting the victim's traffic in real time, at which point TOTP replay is a minor
  concern next to that
- Fixed two real gaps in `releaseParser.ts`'s season/episode extraction found by the audit: the
  `1x01` scene/P2P notation (an extremely common convention, already supported by the filename-based
  scan-import detector but missing entirely from the search-result matcher) had no pattern at all, so
  a release using it could never match a wanted episode and would silently never get grabbed. Added
  it as a fallback behind the unambiguous `SxxExx` pattern. Also fixed hyphen-less chained
  multi-episode packs (`S01E01E02E03`, distinct from the already-supported `S01E01-E03`/`S01E01-03`
  hyphenated form) being parsed as only the first episode. Verified against a 10-case battery
  covering both fixes plus regression checks confirming `x264`/`x265`/`4K` codec and resolution tags
  don't false-match as `1x01`-style season/episode markers

## Round 57
- Continued the audit series onto `scheduler.ts`, `duplicateCheck.ts`, `customFormatScoring.ts`,
  `notifications.ts`, and the Plex/Jellyfin/Emby webhook handler. Found and fixed a real bug: Plex's
  webhook payload does not carry a file path anywhere in its `Metadata` object (confirmed against
  Plex's real wire format, not just assumed — its webhook `Metadata` is a much lighter subset of
  its API's response shape, with no `Media`/`Part`/`file` fields at all, only `ratingKey`/`title`/
  `GUID`/etc.), so `parsePlexPayload` reading `Metadata.Media[0].Part[0].file` always got
  `undefined` and silently returned null for every real Plex webhook — meaning Plex's watch-state
  webhook (the "instant update" path the Dashboard's Recently Watched widget and auto-archival's
  webhook signal both rely on) has never actually fired for any Plex user, full stop, with nothing
  logged to indicate why. Jellyfin/Emby were unaffected — their webhook plugins do send a `Path`
  field directly
- Fixed by resolving the webhook's `ratingKey` through a follow-up call to Plex's own
  `/library/metadata/{ratingKey}` API (new exported `resolvePlexFilePath()` in `mediaServer.ts`,
  reusing the server URL/token config the polling-based watch sync already has), the same way a
  real Plex API client would — `parsePlexPayload` is now async to accommodate the extra round-trip
- Verified live end-to-end with a mock Plex server: configured AoNarr to point at it, sent a real
  multipart `media.scrobble` webhook body with a `ratingKey`, confirmed the mock's file path
  resolved correctly and the matching library item flipped to `watched: true` — something that
  could never have happened with the pre-fix code no matter how correct the rest of the pipeline
  was. Also confirmed the failure path stays graceful when Plex is unreachable: the existing
  route-level try/catch already covers the new async call, responds 200 (so Plex doesn't
  retry-storm), and logs a visible warning instead of crashing
- `scheduler.ts`, `duplicateCheck.ts`, `customFormatScoring.ts`, `notifications.ts`, and the
  Jellyfin/Emby half of the webhook handler all checked out clean — no other bugs found

## Round 56
- Continued the audit series onto `importer.ts`, `naming.ts`, and `mediaServer.ts`. Found and fixed
  one real bug: `{absoluteEpisode}` (the anime-style running episode count naming templates can use
  instead of `{season}`/`{episode}`) was counting season 0 specials into the total, so any show with
  specials had every real episode's absolute number inflated by however many specials sorted before
  it. Real absolute-numbering conventions (AniDB, TVDB's absolute order, most anime release groups)
  start counting from season 1 episode 1 and exclude specials entirely — fixed both `placeFile()`
  and `placeSeasonPackFiles()`'s identical count query to do the same. Verified against a simulated
  12-episode-per-season show with 2 specials: S1E1/S2E1/S2E12 now correctly compute as 1/13/24
  instead of 3/15/26
- Reviewed two other candidates and concluded neither needs a change this round: `importer.ts`
  moves a file to its final destination before writing `has_file`/`path` to the DB in all three
  place* functions — on a crash between those two steps the file sits correctly placed but
  untracked, which is actually the *safer* of the two possible orderings (the reverse would leave
  the DB pointing at a file that doesn't exist) and self-heals on the next Scan & Import since the
  file is already sitting in the root folder in its final form. Separately, `mediaServer.ts`'s
  Jellyfin/Emby watch-state push only targets the first user returned by `/Users` — a real scope
  limit on multi-user instances, but consistent with the feature's existing "low-frequency manual
  admin action" framing rather than an oversight
- Confirmed `naming.ts`'s template token replacement (single regex pass, exact-case tokens, correct
  zero-padding) and `mediaServer.ts`'s Plex vs. Jellyfin vs. Emby API differences (auth header
  names, the `/emby` path prefix Emby needs that Jellyfin dropped) are both handled correctly —
  nothing else to fix in either file

## Round 55
- Continued the provider-audit pass from Round 54 onto the indexer/download-client integrations
  (`indexerClient.ts`, `downloadClient.ts` — Torznab/Newznab, qBittorrent, SABnzbd, Real-Debrid,
  AllDebrid, FlareSolverr, and the http/ytdlp/blackhole adapters). Found one real bug: Torznab's
  `peers` attribute is the release's *total* peer count (seeders + leechers combined), not the
  leecher count on its own — the parser was assigning the raw `peers` value straight into
  `leechers`, so a release with 10 seeders and 5 real leechers (`seeders=10, peers=15` on the wire)
  would report 15 leechers instead of 5. Fixed to derive leechers as peers minus seeders, matching
  how Sonarr/Radarr's own Torznab parsers handle the same attribute, and to prefer an explicit
  `leechers` attr when an indexer happens to emit one directly. Currently has no live UI impact —
  `leechers` is stored and exposed via the API but nothing in the app renders or sorts on it yet —
  fixed anyway since it's real stored/API data with the wrong value. Verified the fix against a
  realistic Torznab XML fixture (seeders=10, peers=15 → correctly derives leechers=5)
- Everything else in both files checked out against the real documented protocol for each client
  (qBittorrent Web API v2, SABnzbd's mode=/apikey params, Real-Debrid and AllDebrid's REST APIs,
  Torznab/Newznab's t=/cat=/apikey= search params)

## Round 54
- Audited every external-provider URL builder in `metadata.ts` (46 functions across TMDB, TVDB,
  TVmaze, Trakt, AniList, MusicBrainz, Deezer, Discogs, Last.fm, Open Library, Google Books,
  ComicVine, MangaDex, RAWG, IGDB, YouTube, ThePornDB, Fanart.tv) for the same class of bug as the
  Open Library fix in Round 52 — a malformed path/param silently 404ing with the failure caught and
  never surfacing anywhere. Nothing else was broken; everything else checked out against each
  provider's real documented API shape
- Routed every remaining `console.warn`/`console.error` in the request-handling path through the
  same `log` service the rest of the app already uses, so failures that used to be visible only via
  `docker logs` now show up on the in-app Logs page too: the metadata child-import failure warning
  (the exact failure mode that hid the Open Library bug from view for however long it had been
  broken), two grab-notification failure warnings, and — the most consequential one — the top-level
  Express error handler that catches every route's unhandled exception app-wide. That last one had
  never gone through `log` at all, meaning any unexpected 500 anywhere in the app was invisible in
  the UI no matter how much of Round 51's logging work covered specific features
- Verified live: sent a deliberately malformed request body to force a real (non-`HttpError`)
  exception through the top-level handler, confirmed it now appears via `GET
  /api/system/logs?level=error`; separately imported an artist with a bogus MusicBrainz id and
  confirmed the child-fetch failure appears via `?level=warn`

## Round 53
- Added have/missing/total counts to every level of the nested-group library browsers (ROMs'
  System → Maker, Online Videos/Courses' Site → Creator, Adult's Site → Maker → Series) — each
  group card now shows a rolled-up `have/total` (e.g. a System's count includes every game under
  every Maker beneath it, not just games attached to the System directly), and the current group's
  own page shows the same as have/missing/total badges, matching every other library page. One
  recursive CTE (`WITH RECURSIVE`) walks arbitrarily many levels of `parent_group_id` per query
  rather than N+1 per-group lookups
- Added an optional, admin-editable description ("metadata for that page") to every group level —
  new `library_groups.overview` column, editable inline on the group's own browse page. Answers
  the "each layer having metadata" half of the ROMs/Online Videos ask that counts alone didn't cover
- Confirmed the Games list under a Maker (and every other grouped type's leaf-level item list) was
  already listing every item regardless of downloaded status, not just downloaded ones — no change
  needed there, just verified live
- Verified this round live end-to-end in a running test container: built a real System → Maker →
  3 Games hierarchy, confirmed the recursive count correctly rolled up through both levels
  (1 have / 3 total at both the System and the Maker), confirmed the description saves and
  persists across a reload, and confirmed the Games list under the Maker still shows all three
  games including the two missing ones

## Round 52
- Added dedicated detail pages for every "collection"-shape library's children (Album, Book,
  Audiobook, Issue, Chapter, Lesson, Video) — new `SubItemDetail.tsx` page at
  `/media/:mediaId/item/:subItemId`, new `GET /media/:id/subitems/:subItemId` endpoint. Clicking
  a child row on an Artist/Author/etc. page now opens its own page with full metadata (release
  date, monitored/file/quality status, file path, external id), instead of the old inline-only
  row. For Music specifically (the only type with a third level), the album page also shows its
  track list and each track links to its own new detail page (`TrackDetail.tsx` at
  `/media/:mediaId/item/:subItemId/track/:trackId`, new `GET
  /media/:id/subitems/:subItemId/tracks/:trackId` endpoint) — completing the requested
  Band → Album → Track drill-down
- Added have/missing/total count badges to the top of every collection-shape parent page (Artist,
  Author, etc.), matching what Round 51 already added for TV Shows and library list pages
- Fixed Books/Audiobooks import silently returning zero books for every author: Open Library's
  author→works URL was being built without the required `/authors/` path segment
  (`https://openlibrary.org${key}/works.json` instead of
  `https://openlibrary.org/authors/${key}/works.json`), so every lookup 404'd, was caught, and
  silently left the library empty — nothing in the UI signaled this had happened. Found while
  verifying the "Author page lists all books" requirement live: a real author import kept coming
  back with `childCount: 0`. Also hardened the general collection-children insert path (used by
  every collection-shape type, not just Books) against a *single* title-less entry from a provider
  aborting the *entire* batch — Open Library's own works list turned out to include one such
  malformed entry even after the URL fix, and since the insert ran as one all-or-nothing
  transaction, that one bad record was silently discarding every good one alongside it
- Verified this round live end-to-end in a running test container: imported a real 100-album
  Radiohead artist (MusicBrainz) and a real Stephen King author (Open Library, 49 of 50 works
  correctly imported, the one title-less entry correctly skipped instead of blocking the batch);
  confirmed the per-parent have/missing/total badges, confirmed clicking an album opens its detail
  page, confirmed a manually-seeded track list renders with its own have/total badge and links to
  a working track detail page with the full Artist / Album breadcrumb, and confirmed a Book child
  (a collection type with no `multiFilePerChild`) opens its detail page correctly with no
  Tracks section shown

## Round 51
- Added per-library have/missing/total count badges to the top of every library list page
  (`LibraryType.tsx`), computed from the already-loaded item list
- Import operations (single-file, music album, and the new TV season-pack path) now log an
  info-level line on success, not just on failure — visible both in `docker logs` and the
  in-app Logs page, since every prior round only logged warnings/errors and gave no visibility
  into what actually happened during a scan-import run
- Added a dedicated episode detail page (`web/src/pages/EpisodeDetail.tsx`, new route
  `/media/:mediaId/episode/:episodeId`, new `GET /media/:id/episodes/:episodeId` endpoint) showing
  full metadata (air date, overview, quality, file info, file path) for a single episode, reachable
  by clicking any episode row on a show's page
- Added the ability to search for a full season at once rather than one episode at a time: the
  search route now accepts a `seasonNumber` with no `episodeId` and matches releases by season only,
  and grabbing such a release now imports the whole season pack (new `placeSeasonPackFiles` in
  `importer.ts`, which walks the sibling files next to the downloaded anchor file and maps each to
  the matching episode by parsing season/episode out of its own name — the same pattern the existing
  music album importer already used for multi-file placement). Needed a new `queue.season_number`
  column to track season-only grabs through the download queue
- Rebuilt the TV Shows (and Anime, which shares the same episodic show shape) metadata page:
  seasons are now closeable/expandable sections like Sonarr, seeded open on first load; each season
  header shows its own have/total badges plus per-season Search/Monitor/Unmonitor actions; the page
  header shows the whole show's have/missing/total counts; episode titles now show the real fetched
  title instead of a bare "EPISODE 1" (falls back to an italic "Episode N" placeholder only when no
  title was ever fetched). Episode metadata fetches (TMDB/TVDB/TVmaze/Trakt/AniList) now also pull
  each episode's overview text, needed a new `episodes.overview` column
- Hardened the scan-import title guesser against dangling-parenthesis titles (e.g. "45 Years (")
  reported on some movies beyond the specific case fixed in Round 49: broadened the cut-pattern list
  to recognize more release-metadata markers (resolution, codec, audio format, edition tags, and
  imdb/tmdb/tvdb id tags) as places to stop, and broadened the trailing-punctuation strip to catch
  more leftover separators. Could not reproduce a fresh failure against the current build with
  realistic test filenames, so this is defensive hardening rather than a confirmed root-cause fix —
  worth watching for a recurrence with a concrete example if it still happens
- Verified this round's TV Shows work live end-to-end in a running test container: imported a real
  62-episode show, confirmed the per-show and per-season count badges, confirmed season sections
  collapse/expand correctly, confirmed clicking an episode navigates to its detail page with full
  metadata, confirmed the "Search season" button reaches the season-only search endpoint and returns
  results, and confirmed the library list page shows the new have/missing/total header

## Round 50
- Fixed TV Shows Scan & Import skipping everything: the episodic branch only ever *matched*
  against an existing series, it never created one — a fresh TV library with nothing pre-added
  in AoNarr yet skipped every single file. Now creates a new series (mirroring what the movie/
  single-shape branch already did) when nothing matches. Also made season/episode + series-title
  detection folder-aware: real TV libraries very often only carry the series name in the folder
  structure (`Series Name/Season 01/S01E01.mkv`, sometimes just `Series Name/Season 01/01.mkv`)
  rather than repeating it in every episode's filename, which the filename-only detection used
  before this couldn't handle at all. Found and fixed a second bug surfaced while verifying
  this: files named just `01x02.mkv`/`E03.mkv` (with the series name only in the folder) were
  getting used as literal series titles instead of falling back to the folder, since the title
  guesser only recognized `SxxExx` as a marker to strip, not the other formats it was actually
  being asked to detect season/episode from. Verified against three episodes of the same series
  using three different naming conventions (`S01E01`, `01x02`, `E03`, series name only in the
  folder) — all three now land under one correctly-created series with the right episode numbers
- Added the ability to search with a custom query and pick a different metadata match for an
  existing item — a Radarr/Sonarr-style "interactive search" popup (new `SearchMatchModal`
  component, `POST /media/:id/rematch`), for exactly the situation a bug report surfaced: an item
  whose title got garbled by an old scan-import bug, where every "Fetch from X" button and Library
  Refresh could only ever search using that same broken stored title and would always come back
  empty. Verified end-to-end in the actual browser: opened the modal, searched a real provider,
  picked a result, and confirmed the item's title/year/overview/poster/externalIds updated

## Round 49
- Fixed the Scan & Import 504: it probed every matched/created file with ffprobe (up to a 30s
  timeout each) synchronously inside the HTTP request, so a library with even a few slow or
  unreadable files could easily exceed any reasonable gateway timeout even though the scan itself
  kept working fine in the background. Both `/media/scan-import` and `/media/refresh` are now
  fire-and-forget — same pattern the scheduled job registry already uses for exactly this reason —
  responding immediately and logging the real result (matched/created/skipped, or updated/failed)
  once it finishes. Verified: the request now returns in ~70ms regardless of library size
- Fixed a real diagnostic dead-end while investigating the above: ffprobe was invoked with `-v
  quiet`, which suppresses its own explanation of *why* a file failed to probe along with the
  routine info it's meant to silence — a genuinely corrupt file logged nothing but "Command
  failed: ffprobe ...", repeating the command back with no reason. Changed to `-v error`; the
  exact same corrupt-file scenario now logs the real cause (e.g. "Failed to read frame size:
  Could not seek to 3071. Invalid argument") instead
- Fixed a title-guessing bug this surfaced: cutting a filename at its year marker left a dangling
  separator behind — "45 Years (2015).wmv" guessed a title of "45 Years (" instead of "45 Years".
  Strips trailing separator punctuation after the cut now; reverified the same file produces a
  clean title

## Round 48
- App icon now appears in the sidebar next to the "AoNarr" wordmark, not just the browser tab
- Default WebUI port changed from 7878 to 9876, everywhere it's referenced: nginx (both the
  combined image's static config and the split web image's template), both Dockerfiles'
  `EXPOSE`/`HEALTHCHECK`, `docker-compose.yml`, the `aonarr`/`aonarr-web` Unraid templates'
  `WebUI`/`Config` port entries, the Remote Library page's example URL placeholder, and the
  current-instructions parts of the README (a historical log entry describing a past port-7878
  bug was left as-is, since rewriting history there would be inaccurate). `aonarr-server.xml`'s
  8989 API port is unrelated to this and wasn't touched. Verified against a real container mapped
  to the new port: root page, `/icon.svg`, and `/api/health` all 200, and Docker's own
  `HEALTHCHECK` (which hits the port internally, not through the host mapping) reports `healthy`
- Removed the default Media/Downloads path values from the two Unraid templates that have them
  (`aonarr.xml`, `aonarr-server.xml` — `aonarr-web.xml` has no path config at all) — previously
  pre-filled with `/mnt/user/media`/`/mnt/user/downloads`, which could look like a working default
  and get skipped past rather than pointed at the user's actual shares; now blank so the field has
  to be deliberately filled in

## Round 47
- Fixed the last of the toolbar height discrepancy: the dropdown trigger's height was set on the
  wrapping `.dropdown` div and inherited by its inner button via `height: 100%` — a percentage
  chain through an inline-flex wrapper that doesn't reliably compute to the exact same pixel value
  as a plain sibling button/select in every browser. Set the height directly and unconditionally
  on the trigger button itself instead, with nothing to inherit through, and let the wrapper
  shrink-wrap to match it exactly
- Widened the Sort select (160px → 210px) — its longest option ("Sort: Recently added") was being
  clipped by the dropdown-arrow padding added in Round 45. Verified via scrollWidth vs clientWidth
  that it no longer clips, and reconfirmed every toolbar control still sits at identical
  top/height pixel values

## Round 46
- Fixed a real bug in Round 45's own fix: the hand-drawn caret background-image on `<select>` had
  no `background-size` set, so it rendered oversized (a giant chevron overlapping the option
  text) instead of the intended small 12×8px arrow — a mistake `getBoundingClientRect()` alone
  couldn't have caught, since box height was already correct; only visually apparent. Added
  `background-size: 12px 8px`, confirmed via computed styles this time (not just element bounds)

## Round 45
- Toolbar `<select>` elements now have their native OS dropdown-arrow chrome stripped entirely
  (`appearance: none` + a hand-drawn caret background image) instead of relying on an explicit
  `height` override to fight it — some browsers keep their own intrinsic sizing around that native
  arrow area regardless of CSS height/padding, which can still show as a shorter/taller control
  next to a plain button even when computed styles look identical in devtools. This is a stricter
  fix than Round 44's, verified again with getBoundingClientRect() (still pixel-identical) plus
  now robust against the browsers where the height-only approach wasn't enough
- Icon v2, per feedback on the first design: the play-mark center is now a hand-drawn geometric
  "A" monogram (three strokes — two diagonals, one crossbar — no font dependency so it renders
  identically everywhere including Docker Hub/Unraid CA), and the single orbiting dot is now 8
  small stars spaced evenly every 45° around the ring

## Round 44
- Found and fixed the actual remaining cause of the Library toolbar misalignment: a `<select>`
  carries its own native intrinsic sizing around the dropdown-arrow area that identical
  padding/border CSS can't fully override, so it still rendered a couple of px taller than a
  `<button>` with pixel-identical box properties. Pinned an explicit height on every `.toolbar`
  child instead of relying on padding/border alone, and split the Library page's single crowded
  toolbar row (9 controls) into two purposeful rows — filters, then view/export/job actions — so
  wrapping on a narrower window happens at a clean boundary instead of mid-row. Verified via
  getBoundingClientRect() on a live page: every control in each row now sits at the exact same
  `top`/`height` pixel values
- Found and fixed a real, previously-undetected bug while wiring up a new app icon: neither
  `web/Dockerfile` nor `Dockerfile.combined` ever copied `web/public/` into the build stage, so
  Vite had nothing to copy into `dist/` — every image built and shipped this entire session was
  silently serving no favicon, no PWA manifest, and no service worker. Added `COPY web/public
  ./public` to both. Verified against a real container: `icon.svg`/`manifest.json`/`sw.js` all
  returned 404 (served the SPA's `index.html` fallback instead) before the fix, all correctly
  return 200 after
- Replaced the placeholder icon (a rounded square with a plain "A") with a custom design — a ring
  around a play mark, in the app's own accent-blue gradient — referenced by a single source file
  (`web/public/icon.svg`) that every required location already pointed at (browser tab favicon,
  PWA manifest, and all four Unraid template/`ca_profile.xml` `<Icon>` tags), so no other file
  needed updating to pick it up

## Round 43
- Library page toolbar buttons (the new "View"/"Export & Bulk" dropdowns, "Scan & Import",
  "Refresh") were using `button.secondary`'s lighter gray instead of matching the black
  `<select>` boxes sitting right next to them in the same row — added a `.select-like` class
  (same background/border/padding as input/select) and applied it to all four, confirmed via
  computed styles that background color, border, and box height now match the selects exactly
- Added the Unraid Community Applications submission files at the repo root: `LICENSE` (MIT),
  `ca_profile.xml`, and moved the existing templates from `unraid-templates/` to `templates/`
  (the layout CA's own starter repo and submission scanner expect), updating each template's
  `TemplateURL` to match and adding a `<License>` tag now that one exists

## Round 42
- Fixed another alignment bug from the same root cause as Round 41's sidebar fix: `button` has a
  global `margin-top: 16px` (meant for a button following a stacked label+input), which also
  pushed toolbar buttons down out of line with the select/input sitting next to them — visible on
  the Logs page's "Load logs" row and every Library page's toolbar. Added a `.toolbar` class that
  resets it, used consistently everywhere a row of controls needs to sit flush on one baseline
- Consolidated each Library page's five export/bulk-edit buttons (Export CSV, .nfo, JSON, Plex,
  Calibre, Bulk edit via CSV) into one "Export & Bulk" dropdown, and the Posters/List view toggle
  into a "View" dropdown — a new reusable `DropdownMenu` component, since nothing like it existed
- Two new jobs, each with a per-library "Scan & Import" / "Refresh" button placed in the same
  toolbar row: **Library Scan & Import** walks a library type's root folder(s) for media files not
  already tracked, matches them into an existing "missing" item by filename-guessed title where
  possible (has_file + path, same as a normal import) or creates a new item outright when nothing
  matches — scoped to single/episodic shapes (Movies, TV, Anime, ROMs, Adult) since collection
  shapes (Books, Comics, Music, Online Videos, Courses) need an existing parent to file a new child
  under, so those report a clear "not supported yet" instead of guessing at structure. **Library
  Refresh** re-pulls overview/poster/year from the type's metadata provider for every existing
  item. Verified scan & import against real files in a running container: matched an existing
  "missing" item by parsed title, correctly parsed quality from the filename for both the matched
  and newly-created item, and a second run against the same files found nothing new (idempotent)

## Round 41
- Fixed a real sidebar layout bug: `.sidebar a` had no `display` set, so nav links defaulted to
  `display: inline` and wrapped like text instead of stacking one per line — visible as staggered,
  out-of-line text any time a dropdown (Library, Manage, Configuration, System) had more than a
  couple of items open

## Round 40
- Plex-specific metadata export: the existing .nfo export only ever covered Kodi/Jellyfin/Emby —
  Plex's own local-media agents don't read .nfo sidecars at all. Added `.plexmatch` (Plex's own
  match-override text format, since PMS 1.25) as a new export option, both individually and in
  bulk (as `.plexmatch` + `poster.jpg` inside each item's own folder, since it has to be named
  exactly that to be picked up — never per-title-named like the other sidecar formats)

## Round 39
- Watch-state sync now flows both ways — previously only the media server could tell AoNarr
  something was watched (via the webhook or the periodic poll behind auto-archival). A "Mark
  watched"/"Mark unwatched" button on the media detail page writes AoNarr's own watch_events
  *and* best-effort pushes the same state to the configured Plex/Jellyfin/Emby server (resolved by
  file-path match, same tail-matching heuristic library validation already uses); a media-server
  push failure is reported but never rolls back AoNarr's own local state. Jellyfin/Emby's
  PlayedItems endpoint was verified live against a public Jellyfin demo server (both a real 401
  from a fake token and full round-trip through the actual UI); Plex's long-stable :/scrobble
  endpoint is implemented per its documented contract but has no public demo server to verify
  against the same way

## Round 38
- Bulk metadata export now includes the actual poster image, not just a remote URL reference
  inside the .nfo/.opf sidecar — `poster.jpg` alongside each item in the Kodi/Jellyfin/Emby-style
  bulk export, `cover.jpg` (Calibre's own convention) in the Calibre export, so the exported
  package is genuinely self-contained instead of needing internet access later to resolve it

## Round 37
- AllDebrid support as a second "debrid" download client type alongside Real-Debrid — same shape
  (grab a magnet/torrent, wait for their servers to cache it, pull the unlocked link(s) directly),
  different provider and API. Unlike Real-Debrid, AllDebrid's upload endpoint accepts a magnet URI
  or a .torrent URL through the same parameter, so no separate code path per input shape was
  needed

## Round 36
- Blackhole download client type — for a torrent/usenet client with no usable HTTP API, AoNarr
  drops the release as a .magnet/.torrent/.nzb file into a watch folder for that client to pick
  up on its own, the oldest and most universal *Starr integration pattern. Fire-and-forget by
  design (documented clearly in the UI): AoNarr can't track an unknown external client's progress,
  so the queue entry stays "downloading" — point the client's own completed output at a root
  folder to get files into the library

## Round 35
- Import Lists finally got a UI (Manage → Import Lists) — the recurring Trakt/IMDb auto-add
  backend has existed since Round 27's generalization from the old single Trakt-sync setting, but
  had no page to manage it from; found while adding a new source type and not wanting to add a
  UI-less feature on top of another UI-less feature
- Last.fm added as a third import list source type — imports a Last.fm profile's all-time top
  artists into Music (Last.fm has no user-playlist concept of its own, so top artists is the
  closest equivalent); required dropping the `import_lists.type` CHECK constraint the same way
  indexers/download_clients did previously, verified against a real pre-existing database that
  the migration preserves existing rows and unlocks the new type
- Logs page: filter by level, search by text, and a "Download .log" export button; bumped the
  in-memory log buffer from 500 to 2000 lines

## Round 34
- Video Channel Check: a scheduled job that re-lists every monitored Online Videos channel's
  current uploads, adds any video not already known as a new sub-item, and — if a yt-dlp download
  client is configured — auto-grabs it immediately, closing the gap where channels previously
  only ever got their video list populated once at add time with no way to pick up new uploads
  short of manually re-adding the channel

## Round 33
- Friend Libraries (Manage → Friend Libraries) — connect a friend's own Plex/Jellyfin/Emby server
  (shared with you, separate from the media server AoNarr manages its own library against) and
  compare their library against yours by title/year to see what they have that you're missing,
  with a one-click "Add" straight into the existing Add Media flow, pre-filled and auto-searched

## Round 32
- Auto Upgrade: an opt-in scheduled job (Settings → General, off by default) that finds every
  item currently below its quality profile's cutoff and runs it back through search-and-grab, so
  raising a cutoff actually gets enforced over time instead of just being a report an admin has
  to act on by hand
- "Create new folder" in the folder-browser picker (Settings → Root Folders → Browse...) — create
  a subfolder on disk from the picker itself, instead of only being able to select folders that
  already exist

## Round 31
- Real-Debrid support as a new download client type — grabbed magnet/torrent links are sent to
  Real-Debrid's API, AoNarr polls until they're cached, then unrestricts and downloads the
  resulting link(s) directly; no host/port to configure, just an API token from Real-Debrid's
  account page
- Custom theme support — a raw-CSS field in Settings → General, served publicly at
  `/api/theme.css` (no login needed, same as the stylesheet itself) and loaded for everyone on
  next page load; documents the app's CSS variables (`--accent`, `--bg`, etc.) so an admin can
  reskin the instance without editing source

Found and fixed a real bug while building the theme feature: a static `<link>` tag in
`index.html` had no guaranteed position relative to Vite's build-injected bundled stylesheet, so
on a `:root { --accent: ... }` specificity tie the wrong one could win depending on injection
order. Fixed by fetching and appending the custom CSS as a `<style>` tag at runtime instead,
which guarantees it lands after the bundled stylesheet in the DOM.

## Round 30
- Corrupt media detection: a scheduled job (+ an on-demand "Check for corruption" button on media
  detail pages) validates every file with ffprobe, moving anything that fails — including a real
  video-library file that ffprobe reads fine but has no video stream at all, a classic sign of a
  fake/mislabeled release — to the Recycle Bin and marking it missing so auto-search retries it
- Folder-browser picker (the "Browse for folder" pattern the other *Starr apps use) instead of
  typing/pasting a path blind, wired into Root Folders
- Audio-only ripping for the yt-dlp download client — extracts to mp3 instead of saving video,
  for pulling music out of a video source

Also found and fixed a real bug while building the audio-only toggle: the download clients PATCH
route passed raw JS booleans straight to better-sqlite3, which rejects them outright — coerced to
1/0 for the columns that are actually booleans.

## Round 29
- TRaSH-Guides custom format import — paste a TRaSH-Guides/Radarr/Sonarr custom format JSON
  export and title/release-group/size conditions translate directly into a real custom format;
  unsupported condition types (language, etc.) are reported as skipped rather than silently lost
- Metadata export: individual (.nfo or JSON, from a media item's own page) and bulk (a .zip of one
  file per item, from any library type's page)
- Calibre export — a .zip of Calibre-compatible .opf sidecars for Books/Audiobooks/Comics/Manga
- Network Stats page — per-download-client bandwidth totals plus a queue status/size breakdown

This closes out the last of the originally-listed "straightforward" batch from a few rounds back.

## Round 28
- Anime absolute-episode naming: new {absoluteEpisode} naming token (a running count across every
  season) as an alternative to {season}/{episode}, alongside the existing global numbering
- Prowlarr indexer sync — mirrors your Prowlarr instance's indexer list in, searches go through
  Prowlarr's own per-indexer proxy so credentials stay managed there; scheduled job + manual sync
- Trailers on the media detail page (movies/series/anime, via TMDB) when a trailer is available
- Notifications expanded to Matrix and SMS (Twilio), alongside the existing
  Discord/Slack/Telegram/Pushover/webhook/email channels

## Round 27
- New Manga library (Books-shaped, metadata from AniList and MangaDex — both free, no API key)
- Missing page: episodes now group by series with a "Search all missing in this series" button,
  and every row (movies/episodes/albums/books) got an individual "Search" button, not just bulk
- Complete size details: total + per-library size on the Dashboard, a size per type on the
  Library overview page, and each library type's own page now shows its size — computed from
  actual on-disk file sizes (cached 10 minutes), not just free-space-remaining like before
- Confirmed already covered by earlier rounds, no new work needed: max-quality-wanted (quality
  profile "cutoff" already caps upgrades there), audio/video codec display (already shown on
  Media Detail via ffprobe-derived info), and logs outside the container (already written to
  stdout/stderr for `docker logs`, in addition to the in-app System → Logs tab)

## Round 26
- Stalled-download cleanup job: a queue item with no progress for longer than a configurable
  threshold gets dropped and retried with the next-best release, same as a failed grab
- Archive unpacking: .zip (built-in), .7z/.rar (if the `7z`/`unrar` binary is present) inside a
  download are unpacked automatically before the importer looks for the media file
- SOCKS5 proxy support — routes every outbound request (indexers, metadata providers, download
  client APIs) through a configured proxy, takes effect immediately with no restart
- External URL setting, used to build share links correctly behind a reverse proxy where the
  browser's own URL doesn't match the actual public one

## Round 25
- Job scheduling system: every background job (auto-search, queue poll, auto-archival, Trakt
  sync, import lists, disk usage sampling, recycle bin cleanup, scheduled backup) now has an
  editable schedule, a manual "run now", and best-effort cancellation, all on a new Jobs page
- Recycle bin: files removed via Media Detail's opt-in "delete files" or auto-archival's
  permanent-delete option move into a type-namespaced recycle bin instead of being deleted
  outright, with a scheduled cleanup job (editable via Jobs) purging entries past retention. New
  Recycle Bin page groups entries by library type and can restore or permanently delete each one.

## Round 24
- Media detail pages now show the poster image (previously never rendered at all) alongside a
  Details panel: added date, quality profile, root folder, file path, tags, and external IDs
  rendered as links to TMDB/IMDb/TVDB/TVmaze/AniList/MusicBrainz/Discogs/Open Library/Comic
  Vine/IGDB/Trakt where the provider is recognized
- Fixed a frontend type gap: MediaItem was missing externalIds entirely, so it was never
  accessible on the detail page despite the API always returning it

## Round 23
- Poster size option (small/medium/large, persisted per browser) on every library type's poster view
- Verified Online Videos' and Courses' group hierarchies live against the actual published image,
  not just typechecked — both browse and label correctly at every level

## Round 22
- Multi-source metadata on the media detail page — pull a second opinion from any other
  configured provider for that type without touching the item's primary overview/poster, then
  optionally promote a source's overview or poster to primary
- PATCH /api/media/:id now accepts overview/posterUrl directly, backing that promotion

## Round 21
- Verified Adult's 3-level hierarchy (Site → Maker → Series) end-to-end, not just typechecked
- Add Media now shows cascading group pickers (with inline "+ New" at every level) for grouped
  types, so a new ROM/Adult/Online Video/Course item can be filed into its group on creation
- Media detail pages for grouped types show their current location and a "Move to group..." panel
  to refile an existing item

## Round 20
- Nested library grouping (generic `library_groups` table + API) for the library types whose
  real-world organization goes deeper than one level: ROMs (System → Maker → Game), Adult
  (Site → Maker → Series → Video), Online Videos (Site → Creator), and Courses (Site → Creator)
- Library pages for those types now browse through the group hierarchy before showing items, with
  breadcrumbs, in-place group creation/deletion, and an "ungrouped items" fallback view
- `/api/media` and the add-media endpoint accept a `groupId` to file an item directly under a group

## Round 19
- Library restructured: a landing page showing recently-added across every type plus per-type
  cards, and each library type now has its own page with sort/status-filter/tag-filter and a
  posters-vs-list view toggle (persisted per browser)
- Sidebar reorganized into collapsible groups (Library, Manage, Configuration, System) instead of
  one long flat list, with the Library group expanded to show every type as a direct link

## Round 18
- Indexer rate-limit backoff — a 429 pauses that indexer for 15m instead of retrying every cycle
- Consolidated health dashboard now also covers download client reachability and low disk space
- Admin-triggered password reset for household accounts, with automatic session revocation
- Settings and System pages reorganized into tabs instead of one long scroll
- Users/Indexers/Download Clients/Watchlist Import "Add" flows moved into popup dialogs
- Watchlist Import gained a single-title add option alongside the existing CSV upload

## Round 17
- Guided first-run onboarding wizard (root folder → indexer → download client checklist)
- SMTP email notifications alongside the existing webhook/bot providers
- Import lists — recurring Trakt/IMDb list auto-add, generalized from the old single Trakt-sync setting
- Audiobooks as a distinct library type
- Public, revocable share links for a single media item's overview/poster
- Per-account TOTP two-factor (household and admin-via-session, not just the legacy API key)
- Docker-secrets-style `_FILE` env vars, plus non-interactive admin account bootstrap
- In-app update checker comparing the running image's build time against Docker Hub

## Round 16
- Multi-instance federation — browse another AoNarr instance's library read-only
- Smart collections — a saved filter re-evaluated live instead of a fixed item list
- Release-group reputation tracking, used as a search tiebreaker
- Bulk edit via CSV upload (the inverse of CSV export)
- Storage quota per root folder, with optional auto-pause of new grabs
- Duplicate request detection for household requests
- Search window scheduling — restrict auto-search to a daily time window
- Media server library validation (AoNarr's library vs. what Plex/Jellyfin/Emby actually reports)

## Round 15
- Plex/Jellyfin/Emby webhook receiver for instant "recently watched" updates
- Self-hosted OpenAPI/Swagger docs page at `/api-docs`
- Download queue manual reordering/priority (qBittorrent, SABnzbd)
- Parental/content rating controls per household user
- Torrent client health stats (seed ratio, upload/download totals, ratio-limit warnings)
- Remote backup destination (S3-compatible: AWS S3, MinIO, Backblaze B2, etc.)
- In-app changelog page (this page)
- Saved/recent searches on Global Search
- Actor/cast browsing pages

## Round 14
- ffprobe media info extraction on import (real codec/resolution/bitrate)
- Automatic failed-grab retry (blocklists the failed release, tries the next-best result)
- FlareSolverr indexer proxy support for Cloudflare-protected indexers
- Import exclusions ("never add this again")
- Custom scripts on grab/import/failure events
- Bulk cleanup suggestions (unmonitored + no file, duplicate-content files)
- Per-user request/storage stats
- Keyboard shortcuts + command palette (Ctrl/Cmd+K)
- Scene-name fallback search

## Round 13
- Season-level monitor toggle
- Multiple root folders per type with free-space auto-selection
- NFO metadata import (Kodi/Jellyfin-style sidecar files)
- Active session list + revoke for household accounts
- Scheduled automatic backups (local)
- CSV export of the library
- Home dashboard (Recently Added, Recently Watched, Upcoming)
- Additional subtitle providers via a generic Custom (JSON API) type

## Round 12
- Login rate-limiting (API key + TOTP)
- Docker HEALTHCHECK on both containers
- In-app log viewer
- Prometheus `/metrics` endpoint
- Duplicate-on-add confirmation
- Scheduled quiet hours for auto-search
- Watchlist CSV import (IMDb/Letterboxd/Trakt)
- iCal feed for the release calendar
- Light/dark theme toggle
- Customizable notification message templates

## Round 11 and earlier
Multi-user accounts and a request portal, watch-status auto-archival, a unified health dashboard,
backup/restore, release blocklist, recommendations, Trakt list sync, duplicate/upgrade detection,
per-user request limits, an activity/audit log, PWA + Web Push notifications, a generic DDL/RSS
indexer protocol, direct-HTTP and yt-dlp download clients, search caching, collections as
exportable playlists, a unified activity timeline, upgrade-candidate detection, storage
forecasting, bulk Library/Missing actions, config template import/export, and TOTP two-factor
login — see README.md for the complete history.
