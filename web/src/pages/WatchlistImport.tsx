import { useRef, useState } from "react";
import { api } from "../api/client.js";
import type { MediaType } from "../types.js";

interface ParsedRow {
  title: string;
  year: number | null;
  type: MediaType;
}

interface RowResult {
  title: string;
  status: "added" | "skipped_duplicate" | "not_found" | "error";
  detail?: string;
}

const STATUS_LABELS: Record<RowResult["status"], string> = {
  added: "Added",
  skipped_duplicate: "Already in library",
  not_found: "No metadata match found",
  error: "Error",
};

/** Splits one CSV line respecting double-quoted fields (which may contain commas) — good enough
 * for the exports this targets (IMDb/Letterboxd/Trakt), none of which use exotic CSV features
 * like embedded newlines inside a field. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/** Recognizes IMDb ("Title"/"Title Type"/"Year"), Letterboxd ("Name"/"Year"), and Trakt
 * ("title"/"type"/"year") watchlist export headers, case-insensitively. */
function parseCsv(text: string): ParsedRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());

  const titleIdx = headers.findIndex((h) => h === "title" || h === "name");
  const yearIdx = headers.findIndex((h) => h === "year");
  const typeIdx = headers.findIndex((h) => h === "title type" || h === "type");
  if (titleIdx === -1) return [];

  const rows: ParsedRow[] = [];
  for (const line of lines.slice(1)) {
    const fields = splitCsvLine(line);
    const title = fields[titleIdx]?.trim();
    if (!title) continue;
    const yearRaw = yearIdx !== -1 ? fields[yearIdx]?.trim() : "";
    const year = yearRaw && /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null;
    const typeRaw = (typeIdx !== -1 ? fields[typeIdx] : "")?.trim().toLowerCase();
    const type: MediaType = typeRaw?.includes("tv") || typeRaw?.includes("show") ? "series" : "movie";
    rows.push({ title, year, type });
  }
  return rows;
}

export default function WatchlistImport() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<RowResult[] | null>(null);

  async function handleFile(file: File) {
    const text = await file.text();
    const parsed = parseCsv(text);
    setFileName(file.name);
    setRows(parsed);
    setResults(null);
  }

  async function runImport() {
    if (!rows || rows.length === 0) return;
    setImporting(true);
    setResults(null);
    try {
      const response = await api.post<{ results: RowResult[] }>("/watchlist-import", { rows });
      setResults(response.results);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setImporting(false);
    }
  }

  return (
    <div>
      <h1>Watchlist Import</h1>
      <p style={{ color: "var(--muted)" }}>
        Bulk-import a watchlist export — IMDb ("Your Watchlist" → Export), Letterboxd
        (Settings → Import &amp; Export → Export your data → <code>watchlist.csv</code>), or a
        Trakt CSV export. Each title is metadata-searched and the best match added as monitored;
        rows with no match, or that look like duplicates of something already in the library, are
        skipped and reported rather than guessed at.
      </p>

      <div className="form-panel">
        <button type="button" onClick={() => fileInputRef.current?.click()}>
          Choose CSV file...
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          style={{ display: "none" }}
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
        {fileName && (
          <p style={{ marginTop: 8 }}>
            <strong>{fileName}</strong> — {rows?.length ?? 0} row(s) recognized
            {rows && rows.length === 0 && " (no Title/Name column found — check the file is a real export)"}
          </p>
        )}
        {rows && rows.length > 0 && (
          <button type="button" onClick={runImport} disabled={importing} style={{ marginTop: 8 }}>
            {importing ? "Importing..." : `Import ${rows.length} title(s)`}
          </button>
        )}
      </div>

      {results && (
        <>
          <h2>Results</h2>
          <p style={{ color: "var(--muted)" }}>
            {results.filter((r) => r.status === "added").length} added,{" "}
            {results.filter((r) => r.status === "skipped_duplicate").length} already in library,{" "}
            {results.filter((r) => r.status === "not_found").length} not found,{" "}
            {results.filter((r) => r.status === "error").length} errored.
          </p>
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, idx) => (
                <tr key={idx}>
                  <td>{r.title}</td>
                  <td>
                    <span
                      className={`badge ${
                        r.status === "added" ? "ok" : r.status === "error" ? "danger" : ""
                      }`}
                    >
                      {STATUS_LABELS[r.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
