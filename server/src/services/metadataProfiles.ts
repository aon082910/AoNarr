import { db } from "../db/index.js";
import { getSetting } from "./settingsStore.js";

/**
 * Lidarr and Readarr decide per artist or author which of the provider's releases are listed at all.
 * AoNarr's metadata profile does the same: a music profile lists the release groups of the chosen
 * primary types and drops those that carry an excluded secondary type; a book profile can skip works
 * without a date and box sets. An item uses its own profile, else its root folder's default, else the
 * `defaultMetadataProfileId` setting, else none, which is the global `musicAlbumTypes` setting as before.
 */

export const PRIMARY_ALBUM_TYPES = ["album", "ep", "single", "broadcast", "other"] as const;
/** MusicBrainz's secondary release-group types, lowercased. */
export const SECONDARY_ALBUM_TYPES = [
  "live",
  "compilation",
  "soundtrack",
  "spokenword",
  "interview",
  "audiobook",
  "audio drama",
  "remix",
  "dj-mix",
  "mixtape/street",
  "demo",
  "field recording",
] as const;

export interface MetadataProfile {
  id: number;
  name: string;
  primaryTypes: string[];
  excludedSecondaryTypes: string[];
  skipMissingDate: boolean;
  skipSets: boolean;
}

function parseList(raw: unknown): string[] {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(value) ? value.map((v) => String(v).trim().toLowerCase()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function metadataProfileFromRow(row: any): MetadataProfile {
  return {
    id: Number(row.id),
    name: row.name,
    primaryTypes: parseList(row.primary_types),
    excludedSecondaryTypes: parseList(row.excluded_secondary_types),
    skipMissingDate: !!Number(row.skip_missing_date ?? 0),
    skipSets: !!Number(row.skip_sets ?? 0),
  };
}

export async function loadMetadataProfile(id: number | null | undefined): Promise<MetadataProfile | null> {
  if (id == null) return null;
  const row = await db.prepare("SELECT * FROM metadata_profiles WHERE id = ?").get(Number(id));
  return row ? metadataProfileFromRow(row) : null;
}

/** The profile that applies to an item (see the file comment); null means the global setting. */
export async function resolveMetadataProfile(item: { metadata_profile_id?: number | null; root_folder_id?: number | null }): Promise<MetadataProfile | null> {
  const own = await loadMetadataProfile(item.metadata_profile_id);
  if (own) return own;
  if (item.root_folder_id != null) {
    const root = (await db.prepare("SELECT default_metadata_profile_id FROM root_folders WHERE id = ?").get(Number(item.root_folder_id))) as
      | { default_metadata_profile_id: number | null }
      | undefined;
    const fromRoot = await loadMetadataProfile(root?.default_metadata_profile_id);
    if (fromRoot) return fromRoot;
  }
  const configured = parseInt(getSetting("defaultMetadataProfileId") ?? "", 10);
  return Number.isFinite(configured) ? loadMetadataProfile(configured) : null;
}

/** The profile for an item that is not stored yet (an Add): the one the request names, else its root folder's default. */
export async function resolveMetadataProfileForAdd(requested: number | null | undefined, rootFolderId: number | null | undefined): Promise<MetadataProfile | null> {
  return resolveMetadataProfile({ metadata_profile_id: requested ?? null, root_folder_id: rootFolderId ?? null });
}

/** A music release group as a provider lists it. MusicBrainz is the only provider that reports types. */
interface TypedAlbum {
  primaryType?: string | null;
  secondaryTypes?: string[] | null;
}

/** Drops the albums the profile does not list. A provider that reports no types is not filtered by them. */
export function filterAlbumsByProfile<T extends TypedAlbum & { releaseDate?: string | null }>(albums: T[], profile: MetadataProfile | null): T[] {
  if (!profile) return albums;
  const primary = new Set(profile.primaryTypes);
  const excluded = new Set(profile.excludedSecondaryTypes);
  return albums.filter((a) => {
    if (a.primaryType && primary.size > 0 && !primary.has(a.primaryType.toLowerCase())) return false;
    if (a.secondaryTypes?.some((t) => excluded.has(String(t).toLowerCase()))) return false;
    return true;
  });
}

const SET_TITLE = /\b(box(ed)?\s*set|omnibus|complete\s+(series|works|saga|novels|collection)|trilogy|books?\s+\d+\s*(?:-|to|&)\s*\d+|\d+\s*-?\s*book\s+(set|series|collection|bundle))\b/i;

/** Drops the books the profile does not list: a work with no date, a box set. */
export function filterBooksByProfile<T extends { title: string; releaseDate?: string | null }>(books: T[], profile: MetadataProfile | null): T[] {
  if (!profile) return books;
  return books.filter((b) => {
    if (profile.skipMissingDate && !b.releaseDate) return false;
    if (profile.skipSets && SET_TITLE.test(b.title)) return false;
    return true;
  });
}

/** The MusicBrainz `type` filter value: the profile's primary types, else the global setting. */
export function musicbrainzTypeFilter(profile: MetadataProfile | null, fallback: string[]): string {
  const types = profile && profile.primaryTypes.length > 0 ? profile.primaryTypes : fallback;
  return types.join("|");
}

/** A request body's profile fields, checked. Throws a message for a bad value. */
export function validateMetadataProfileInput(b: any, forCreate: boolean): {
  name?: string;
  primaryTypes?: string[];
  excludedSecondaryTypes?: string[];
  skipMissingDate?: boolean;
  skipSets?: boolean;
} {
  const out: ReturnType<typeof validateMetadataProfileInput> = {};
  if (b.name !== undefined || forCreate) {
    if (typeof b.name !== "string" || !b.name.trim()) throw new Error("name is required");
    out.name = b.name.trim();
  }
  const list = (value: unknown, allowed: readonly string[], label: string): string[] => {
    if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
    const items = [...new Set(value.map((v) => String(v).trim().toLowerCase()).filter(Boolean))];
    const unknown = items.find((i) => !allowed.includes(i));
    if (unknown) throw new Error(`${label}: "${unknown}" is not one of ${allowed.join(", ")}`);
    return items;
  };
  if (b.primaryTypes !== undefined) {
    out.primaryTypes = list(b.primaryTypes, PRIMARY_ALBUM_TYPES, "primaryTypes");
    if (out.primaryTypes.length === 0) throw new Error("primaryTypes needs at least one type");
  } else if (forCreate) out.primaryTypes = ["album"];
  if (b.excludedSecondaryTypes !== undefined) out.excludedSecondaryTypes = list(b.excludedSecondaryTypes, SECONDARY_ALBUM_TYPES, "excludedSecondaryTypes");
  if (b.skipMissingDate !== undefined) out.skipMissingDate = !!b.skipMissingDate;
  if (b.skipSets !== undefined) out.skipSets = !!b.skipSets;
  return out;
}
