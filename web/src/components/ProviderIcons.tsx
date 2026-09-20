/**
 * Small colored badge icons for external metadata providers (TMDB, IMDb, TVDB, ...) — unlike the
 * monochrome `currentColor` stroke icons in NavIcons.tsx/ActionIcons.tsx, these need their own
 * per-brand fill color since the whole point of showing one is visually telling providers apart at
 * a glance instead of a generic globe + a blue text link (see MediaDetail.tsx's external-id pills).
 * Same 18px/24-viewBox footprint as the Icon() wrapper in NavIcons.tsx for drop-in consistency
 * inside a toolbar/pill/link. Simplified letter monograms rather than reproductions of each site's
 * actual logo mark — distinct and recognizable at this size without depending on trademarked
 * artwork.
 */
function ProviderBadge({ label, bg, fg = "#fff" }: { label: string; bg: string; fg?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ flexShrink: 0 }}>
      <rect x="1" y="1" width="22" height="22" rx="5" fill={bg} />
      <text x="12" y="15.5" textAnchor="middle" fontSize="8.5" fontWeight="700" fontFamily="system-ui, sans-serif" fill={fg} letterSpacing="-0.3">
        {label}
      </text>
    </svg>
  );
}

export function TmdbIcon() {
  return <ProviderBadge label="TM" bg="#01b4e4" />;
}
export function ImdbIcon() {
  return <ProviderBadge label="IM" bg="#f5c518" fg="#000" />;
}
export function OmdbIcon() {
  return <ProviderBadge label="OM" bg="#2c3e50" />;
}
export function TraktIcon() {
  return <ProviderBadge label="TR" bg="#ed1c24" />;
}
export function TvdbIcon() {
  return <ProviderBadge label="TV" bg="#2b9348" />;
}
export function TvmazeIcon() {
  return <ProviderBadge label="TZ" bg="#4a4ae0" />;
}
export function AnilistIcon() {
  return <ProviderBadge label="AL" bg="#02a9ff" />;
}
export function MusicbrainzIcon() {
  return <ProviderBadge label="MB" bg="#ba478f" />;
}
export function DeezerIcon() {
  return <ProviderBadge label="DZ" bg="#a238ff" />;
}
export function DiscogsIcon() {
  return <ProviderBadge label="DC" bg="#000000" />;
}
export function LastfmIcon() {
  return <ProviderBadge label="FM" bg="#d51007" />;
}
export function OpenlibraryIcon() {
  return <ProviderBadge label="OL" bg="#1a2b4c" />;
}
export function GooglebooksIcon() {
  return <ProviderBadge label="GB" bg="#4285f4" />;
}
export function ItunesIcon() {
  return <ProviderBadge label="IT" bg="#fa57c1" />;
}
export function HardcoverIcon() {
  return <ProviderBadge label="HC" bg="#f4a300" fg="#000" />;
}
export function GoodreadsIcon() {
  return <ProviderBadge label="GR" bg="#553b0c" />;
}
export function AudnexusIcon() {
  return <ProviderBadge label="AX" bg="#6f42c1" />;
}
export function AudibleIcon() {
  return <ProviderBadge label="AB" bg="#f8991c" fg="#000" />;
}
export function ComicvineIcon() {
  return <ProviderBadge label="CV" bg="#f1592a" />;
}
export function MangadexIcon() {
  return <ProviderBadge label="MD" bg="#ff6740" />;
}
export function RawgIcon() {
  return <ProviderBadge label="RW" bg="#2c2c2c" fg="#eeff00" />;
}
export function IgdbIcon() {
  return <ProviderBadge label="IG" bg="#9147ff" />;
}
export function ScreenscraperIcon() {
  return <ProviderBadge label="SS" bg="#005a9c" />;
}
export function ThegamesdbIcon() {
  return <ProviderBadge label="GD" bg="#16a085" />;
}
export function YoutubeIcon() {
  return <ProviderBadge label="YT" bg="#ff0000" />;
}
export function VimeoIcon() {
  return <ProviderBadge label="VM" bg="#1ab7ea" />;
}
export function TheporndbIcon() {
  return <ProviderBadge label="PB" bg="#e91e63" />;
}

/** Every provider covered above, keyed the same as `metadataProviders`/`external_ids` (plus
 * `imdb`, which is populated via TMDB's external_ids lookup rather than being a pickable
 * provider itself, but still shows up as a link). */
export const PROVIDER_ICONS: Record<string, () => JSX.Element> = {
  tmdb: TmdbIcon,
  imdb: ImdbIcon,
  omdb: OmdbIcon,
  trakt: TraktIcon,
  tvdb: TvdbIcon,
  tvmaze: TvmazeIcon,
  anilist: AnilistIcon,
  musicbrainz: MusicbrainzIcon,
  deezer: DeezerIcon,
  discogs: DiscogsIcon,
  lastfm: LastfmIcon,
  openlibrary: OpenlibraryIcon,
  googlebooks: GooglebooksIcon,
  itunes: ItunesIcon,
  hardcover: HardcoverIcon,
  goodreads: GoodreadsIcon,
  audnexus: AudnexusIcon,
  audible: AudibleIcon,
  comicvine: ComicvineIcon,
  mangadex: MangadexIcon,
  rawg: RawgIcon,
  igdb: IgdbIcon,
  screenscraper: ScreenscraperIcon,
  thegamesdb: ThegamesdbIcon,
  youtube: YoutubeIcon,
  vimeo: VimeoIcon,
  theporndb: TheporndbIcon,
};

/** Looks up a provider's badge by key, falling back to a neutral (theme-colored, not brand-colored)
 * badge with its own first two letters for any provider not covered above — so a newly-added
 * provider never renders as literally nothing. */
export function ProviderIcon({ provider }: { provider: string }) {
  const Known = PROVIDER_ICONS[provider];
  if (Known) return <Known />;
  return <ProviderBadge label={provider.slice(0, 2).toUpperCase()} bg="var(--border)" fg="var(--text)" />;
}
