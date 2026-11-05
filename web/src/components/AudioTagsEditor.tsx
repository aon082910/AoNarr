import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { useBackgroundJobs } from "../context/BackgroundJobsContext.js";
import { formatDateTime } from "../utils/dateFormat.js";
import { notify } from "../utils/notify.js";

interface FormatCounts {
  written: number;
  skipped: number;
  failed: number;
}

interface RetagSummary {
  titles: number;
  files: number;
  written: number;
  skipped: number;
  failed: number;
  byFormat: Record<string, FormatCounts>;
  reasons: Record<string, number>;
  failures: { file: string; reason: string }[];
  cancelled: boolean;
  startedAt: string;
  finishedAt: string | null;
}

interface RetagStatus {
  running: boolean;
  last: RetagSummary | null;
}

const MODES: [string, string][] = [
  ["none", "Off (default)"],
  ["new", "New files: tag what an import places (an upgrade too)"],
  ["all", "All files: new files, and a pass over the whole library every week"],
  ["sync", "Sync: as All files, and a title's files follow an edit or rematch of its metadata"],
];

const help = { color: "var(--muted)", fontSize: "0.8rem", margin: "0.15rem 0 0.6rem" } as const;

/**
 * Lidarr's "write tags" settings for the music and audiobook files, with the library-wide retag. The tags are written into
 * MP3 (ID3v2), FLAC, M4A/M4B/MP4, OGG and Opus files; ebooks and comics are not written (their metadata is inside a zip).
 */
export default function AudioTagsEditor({ settings, saveSetting }: { settings: Record<string, string>; saveSetting: (key: string, value: string) => void | Promise<void> }) {
  const { jobs, startJob } = useBackgroundJobs();
  const [status, setStatus] = useState<RetagStatus | null>(null);
  const running = jobs.some((j) => j.kind === "retag" && j.type === "library" && j.running);

  function loadStatus() {
    api.get<RetagStatus>("/media/retag/status").then(setStatus).catch(() => undefined);
  }
  // Again when a run ends: the counts of the new run are what the page should show.
  useEffect(loadStatus, [running]);

  // A mode that was never chosen follows the old on/off setting, which meant "new".
  const mode = settings.writeAudioTagsMode || (settings.writeAudioTagsOnImport === "1" ? "new" : "none");
  const last = status?.last ?? null;

  async function retagNow() {
    try {
      await startJob("retag", "library", "Retag audio files", "/media/retag");
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  return (
    <div>
      <p style={{ ...help, marginTop: 0 }}>
        Writes the artist, album, title, track and disc number, year and genre AoNarr knows (and the MusicBrainz ids it has) into the music and audiobook files
        themselves, so they carry correct tags when opened outside AoNarr. An audiobook gets its author as artist, its narrator as composer and its series as the
        grouping. Formats: <strong>MP3</strong> (ID3v2), <strong>FLAC</strong>, <strong>M4A / M4B / MP4</strong>, <strong>OGG</strong> and <strong>Opus</strong>. Ebooks and
        comics (EPUB, PDF, CBZ) are not written: their metadata lives inside the file's archive. Files imported as hardlinks or symlinks are left untagged (changing them
        would alter the download client's seeding copy), and a read-only root folder is never written.
      </p>
      <label htmlFor="settings-audio-tags-mode">Write audio tags</label>
      <select id="settings-audio-tags-mode" key={mode} defaultValue={mode} onChange={(e) => saveSetting("writeAudioTagsMode", e.target.value)}>
        {MODES.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>

      <label htmlFor="settings-audio-tags-scrub">Remove the tags a file has first</label>
      <select id="settings-audio-tags-scrub" key={settings.scrubAudioTags ?? "scrub-empty"} defaultValue={settings.scrubAudioTags ?? "0"} onChange={(e) => saveSetting("scrubAudioTags", e.target.value)}>
        <option value="0">Off: keep the tags AoNarr does not write (default)</option>
        <option value="1">On: scrub every other tag</option>
      </select>
      <p style={help}>
        On, every text tag the file has is removed before the ones above are written (an embedded picture stays unless a new cover replaces it). Off, a tag AoNarr has no field for
        (replay gain, a comment) stays. M4A / M4B files are rewritten with ffmpeg, which can keep only the standard MP4 atoms: one that carries others (an Audible ASIN, an iTunes
        normalisation value) is left as it is unless this is on. The MusicBrainz ids are written to MP3, FLAC, OGG and Opus, not to M4A / M4B.
      </p>

      <label htmlFor="settings-audio-tags-cover">Embed the album cover</label>
      <select id="settings-audio-tags-cover" key={settings.embedAudioCover ?? "cover-empty"} defaultValue={settings.embedAudioCover ?? "0"} onChange={(e) => saveSetting("embedAudioCover", e.target.value)}>
        <option value="0">Off (default)</option>
        <option value="1">On</option>
      </select>
      <p style={help}>
        Puts the picture from the album's folder (cover.jpg, folder.png and so on), else the metadata provider's, into files that have none (with the option above, in place of
        the one they have). Works for MP3, FLAC and M4A / M4B / MP4. OGG and Opus files cannot take a picture through ffmpeg: their tags are written and the cover is left out.
        A cover that cannot be embedded never stops the tags from being written.
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button type="button" className="secondary" onClick={retagNow} disabled={running}>
          {running ? "Retagging…" : "Retag the music and audiobook library now"}
        </button>
        <span style={{ ...help, margin: 0 }}>
          Rewrites the tags of every file to what AoNarr has now, whichever mode is chosen. Files whose tags are already right are not touched. The "Retag Audio Files" job in
          System → Jobs runs the same pass weekly for All files and Sync. A single title has its own Retag button on its page.
        </span>
      </div>

      {last && (
        <div style={{ marginTop: 10, fontSize: "0.85rem" }}>
          <strong>{last.finishedAt ? "Last retag" : "Retag in progress"}</strong>
          {last.finishedAt ? ` (${formatDateTime(last.finishedAt)})` : ""}: {last.written} of {last.files} file(s) written in {last.titles} title(s), {last.skipped} skipped, {last.failed} failed
          {last.cancelled ? ", cancelled before the end" : ""}.
          {Object.keys(last.byFormat).length > 0 && (
            <ul style={{ margin: "0.3rem 0 0", paddingLeft: "1.2rem" }}>
              {Object.entries(last.byFormat).map(([format, counts]) => (
                <li key={format}>
                  {format}: {counts.written} written, {counts.skipped} skipped, {counts.failed} failed
                </li>
              ))}
            </ul>
          )}
          {Object.keys(last.reasons).length > 0 && (
            <details style={{ marginTop: "0.3rem" }}>
              <summary>Why files were skipped or failed</summary>
              <ul style={{ margin: "0.3rem 0 0", paddingLeft: "1.2rem" }}>
                {Object.entries(last.reasons)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 12)
                  .map(([reason, count]) => (
                    <li key={reason}>
                      {count} × {reason}
                    </li>
                  ))}
              </ul>
              {last.failures.length > 0 && (
                <ul style={{ margin: "0.3rem 0 0", paddingLeft: "1.2rem" }}>
                  {last.failures.slice(0, 10).map((f) => (
                    <li key={f.file} style={{ wordBreak: "break-all" }}>
                      {f.file}: {f.reason}
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}
        </div>
      )}
    </div>
  );
}
