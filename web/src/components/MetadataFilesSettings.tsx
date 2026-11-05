import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useBackgroundJobs } from "../context/BackgroundJobsContext.js";
import { notify } from "../utils/notify.js";

interface Props {
  settings: Record<string, string>;
  saveSetting: (key: string, value: string) => Promise<void>;
}

/**
 * Settings, Media Management, Metadata Files: which NFO and picture files AoNarr writes beside the media, by kind of library
 * (Sonarr's Kodi/Emby metadata consumer, per library type). A cell is a switch for one kind of file in one kind of library.
 * Everything is off until switched on, except what "Write NFO on Import" already did.
 */
export default function MetadataFilesSettings({ settings, saveSetting }: Props) {
  const { startJob } = useBackgroundJobs();
  const [starting, setStarting] = useState(false);

  // What the server reads (server/src/services/metadataFileOptions.ts): shows follow the NFO switch until they have their own.
  const nfoMovies = settings.writeNfoOnImport === "1";
  const nfoTv = settings.nfoTvEnabled === "1" ? true : settings.nfoTvEnabled === "0" ? false : nfoMovies;
  const nfoMusic = settings.nfoMusicEnabled === "1";
  const images = settings.writeImagesOnImport === "1";
  const overwrite = settings.overwriteMetadataFiles === "1";
  const posterFanart = settings.imagesPosterFanart !== "0";
  const seasonPosters = settings.imagesSeasonPosters !== "0";
  const episodeThumbs = settings.imagesEpisodeThumbs !== "0";
  const musicCover = settings.imagesMusicCover !== "0";

  function cell(checked: boolean, label: string, onChange: (on: boolean) => void, disabled = false): ReactNode {
    return (
      <input
        type="checkbox"
        style={{ width: "auto" }}
        checked={checked}
        disabled={disabled}
        aria-label={label}
        title={label}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }
  const none = <span style={{ color: "var(--muted)" }} aria-label="not applicable">–</span>;
  const centered = { textAlign: "center" as const };

  async function writeNow() {
    setStarting(true);
    try {
      await startJob("organize", "metadata-files", "Writing metadata files", "/jobs/writeMetadataFiles/run");
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setStarting(false);
    }
  }

  return (
    <div>
      <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
        Files that Kodi, Jellyfin, Emby and Plex read beside your media. Everything is off until you switch it on, so an update never starts writing
        files by itself. A file another tool wrote is never replaced (an NFO with anything beyond title, year, plot, thumb and unique ids in it, such
        as one from Kodi or tinyMediaManager), and the whole thing stays out of read-only libraries and shares that are not mounted. With the NFO switch
        for movies on, editing or rematching a movie's metadata also refreshes its NFO.
      </p>

      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {cell(images, "Write pictures on import", (on) => saveSetting("writeImagesOnImport", on ? "1" : "0"))}
        Write pictures (poster, fanart, season posters, episode pictures, album covers) when a file is imported
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {cell(overwrite, "Replace files that are already there", (on) => saveSetting("overwriteMetadataFiles", on ? "1" : "0"))}
        Replace pictures that are already there, and refresh show, artist and album NFO files AoNarr wrote (an NFO from another tool is still kept)
      </label>

      <table style={{ marginTop: "0.75rem" }}>
        <thead>
          <tr>
            <th>Library</th>
            <th style={centered}>NFO file</th>
            <th style={centered}>Poster + fanart</th>
            <th style={centered}>Season posters</th>
            <th style={centered}>Episode pictures</th>
            <th style={centered}>Cover + artist picture</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              Movies, ROMs, books, comics and other single files
              <div style={{ color: "var(--muted)", fontSize: "0.75rem" }}>NFO next to each imported file</div>
            </td>
            <td style={centered}>{cell(nfoMovies, "NFO file for movies and other single files", (on) => saveSetting("writeNfoOnImport", on ? "1" : "0"))}</td>
            <td style={centered} rowSpan={2}>
              {cell(posterFanart, "Poster and fanart for movies and shows", (on) => saveSetting("imagesPosterFanart", on ? "1" : "0"), !images)}
              <div style={{ color: "var(--muted)", fontSize: "0.75rem" }}>poster.jpg, fanart.jpg</div>
            </td>
            <td style={centered}>{none}</td>
            <td style={centered}>{none}</td>
            <td style={centered}>{none}</td>
          </tr>
          <tr>
            <td>
              TV shows, anime, sports, courses
              <div style={{ color: "var(--muted)", fontSize: "0.75rem" }}>tvshow.nfo and an NFO per episode; follows the row above until you change it</div>
            </td>
            <td style={centered}>{cell(nfoTv, "NFO files for shows", (on) => saveSetting("nfoTvEnabled", on ? "1" : "0"))}</td>
            <td style={centered}>
              {cell(seasonPosters, "Season posters", (on) => saveSetting("imagesSeasonPosters", on ? "1" : "0"), !images)}
              <div style={{ color: "var(--muted)", fontSize: "0.75rem" }}>season01-poster.jpg</div>
            </td>
            <td style={centered}>
              {cell(episodeThumbs, "Episode pictures", (on) => saveSetting("imagesEpisodeThumbs", on ? "1" : "0"), !images)}
              <div style={{ color: "var(--muted)", fontSize: "0.75rem" }}>episode-thumb.jpg</div>
            </td>
            <td style={centered}>{none}</td>
          </tr>
          <tr>
            <td>
              Music
              <div style={{ color: "var(--muted)", fontSize: "0.75rem" }}>artist.nfo and album.nfo with the track list</div>
            </td>
            <td style={centered}>{cell(nfoMusic, "NFO files for music", (on) => saveSetting("nfoMusicEnabled", on ? "1" : "0"))}</td>
            <td style={centered}>{none}</td>
            <td style={centered}>{none}</td>
            <td style={centered}>{none}</td>
            <td style={centered}>
              {cell(musicCover, "Album covers and artist pictures", (on) => saveSetting("imagesMusicCover", on ? "1" : "0"), !images)}
              <div style={{ color: "var(--muted)", fontSize: "0.75rem" }}>folder.jpg, artist.jpg, fanart.jpg</div>
            </td>
          </tr>
        </tbody>
      </table>
      <p style={{ color: "var(--muted)", fontSize: "0.75rem" }}>
        Switches take effect for files imported from now on. A picture is written only when the title has one from its metadata provider.
      </p>

      <h4 style={{ marginBottom: "0.25rem" }}>Titles already in the library</h4>
      <p style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: 0 }}>
        Writes what is switched on above for every title that already has files: one title at a time, with short pauses so a large library does not
        hammer the disks or the metadata providers. Files that are there are kept. It can be cancelled on the{" "}
        <Link to="/jobs">Jobs page</Link> (job "Metadata Files", which can also run weekly if you switch it on), and a single title has a
        "Write Files" button on its page.
      </p>
      <button type="button" onClick={writeNow} disabled={starting}>
        {starting ? "Starting..." : "Write files now"}
      </button>
    </div>
  );
}
