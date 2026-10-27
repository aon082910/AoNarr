import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import type { DownloadClient } from "../src/types/index.js";
import { setupTestDb } from "./helpers/testDb.js";

let encodeSlskdDownloadUrl: (typeof import("../src/services/soulseek.js"))["encodeSlskdDownloadUrl"];
let decodeSlskdDownloadUrl: (typeof import("../src/services/soulseek.js"))["decodeSlskdDownloadUrl"];
let searchSlskd: (typeof import("../src/services/soulseek.js"))["searchSlskd"];
let decodeSlskdFolderUrl: (typeof import("../src/services/soulseek.js"))["decodeSlskdFolderUrl"];
let encodeSlskdFolderUrl: (typeof import("../src/services/soulseek.js"))["encodeSlskdFolderUrl"];
let slskdFolderDownloadId: (typeof import("../src/services/soulseek.js"))["slskdFolderDownloadId"];
let parseSlskdFolderDownloadId: (typeof import("../src/services/soulseek.js"))["parseSlskdFolderDownloadId"];

beforeAll(async () => {
  // soulseek.ts imports logger.js, which touches config.js/db/index.js transitively.
  await setupTestDb();
  ({ encodeSlskdDownloadUrl, decodeSlskdDownloadUrl, searchSlskd, decodeSlskdFolderUrl, encodeSlskdFolderUrl, slskdFolderDownloadId, parseSlskdFolderDownloadId } = await import("../src/services/soulseek.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function fakeClient(overrides: Partial<DownloadClient> = {}): DownloadClient {
  return {
    id: 1,
    name: "Test Soulseek",
    type: "slskd",
    host: "slskd.local",
    port: 5030,
    useSsl: 0,
    username: null,
    password: null,
    apiKey: "test-key",
    category: null,
    enabled: 1,
    audioOnly: 0,
    ...overrides,
  };
}

describe("encodeSlskdDownloadUrl / decodeSlskdDownloadUrl", () => {
  it("round-trips a username, filename, and size through encode then decode", () => {
    const url = encodeSlskdDownloadUrl("someuser", "@@someuser\\Music\\Artist\\Song.mp3", 123456);

    expect(decodeSlskdDownloadUrl(url)).toEqual({
      username: "someuser",
      filename: "@@someuser\\Music\\Artist\\Song.mp3",
      size: 123456,
    });
  });

  it("round-trips values that need URI-escaping (spaces, parens, unicode)", () => {
    const url = encodeSlskdDownloadUrl("cool user 123", "Artist - Song (Live) café.mp3", 999);

    expect(decodeSlskdDownloadUrl(url)).toEqual({
      username: "cool user 123",
      filename: "Artist - Song (Live) café.mp3",
      size: 999,
    });
  });

  it("throws on a malformed URL with no username", () => {
    expect(() => decodeSlskdDownloadUrl("slskd:///justfilename?size=1")).toThrow(/Malformed slskd download URL/);
  });

  it("throws on a malformed URL with no filename", () => {
    expect(() => decodeSlskdDownloadUrl("slskd://someuser/?size=1")).toThrow(/Malformed slskd download URL/);
  });
});

describe("searchSlskd", () => {
  it("creates a search, polls until complete, and maps responses into SearchResult[]", async () => {
    vi.useFakeTimers();
    let pollCount = 0;
    const fetchMock = vi.fn(async (url: string, options?: any) => {
      if (options?.method === "POST") return { ok: true, json: async () => ({ id: "search-1" }) };
      if (url.endsWith("/responses")) {
        return {
          ok: true,
          json: async () => [
            {
              username: "peerA",
              hasFreeUploadSlot: true,
              files: [{ filename: "@@peerA\\Music\\Song.mp3", size: 5_000_000 }],
            },
          ],
        };
      }
      pollCount++;
      return { ok: true, json: async () => ({ isComplete: pollCount >= 2 }) }; // not complete on the first check, complete on the second
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = searchSlskd(fakeClient(), "some track");
    await vi.advanceTimersByTimeAsync(3500);
    const results = await promise;

    expect(results).toEqual([
      {
        indexerId: null,
        indexerName: "Soulseek (peerA)",
        title: "Song.mp3",
        size: 5_000_000,
        // Soulseek has no real seeder-count concept — null, matching every other seederless
        // protocol, not a fabricated 0/1 off hasFreeUploadSlot (see soulseek.ts's own comment).
        seeders: null,
        leechers: null,
        publishDate: null,
        downloadUrl: encodeSlskdDownloadUrl("peerA", "@@peerA\\Music\\Song.mp3", 5_000_000),
        protocol: "slskd",
        category: null,
      },
    ]);
  });

  it("uses the https scheme and sends the API key header when configured", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string, options?: any) => {
      if (options?.method === "POST") return { ok: true, json: async () => ({ id: "search-1" }) };
      if (url.endsWith("/responses")) return { ok: true, json: async () => [] };
      return { ok: true, json: async () => ({ isComplete: true }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = searchSlskd(fakeClient({ useSsl: 1, apiKey: "secret-key" }), "q");
    await vi.advanceTimersByTimeAsync(1500);
    await promise;

    expect(fetchMock.mock.calls[0][0]).toBe("https://slskd.local:5030/api/v0/searches");
    expect(fetchMock.mock.calls[0][1].headers["X-API-Key"]).toBe("secret-key");
  });

  it("skips a poll attempt that returns a non-OK status instead of aborting the search", async () => {
    vi.useFakeTimers();
    let pollCount = 0;
    const fetchMock = vi.fn(async (url: string, options?: any) => {
      if (options?.method === "POST") return { ok: true, json: async () => ({ id: "search-1" }) };
      if (url.endsWith("/responses")) return { ok: true, json: async () => [] };
      pollCount++;
      if (pollCount === 1) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ isComplete: true }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = searchSlskd(fakeClient(), "q");
    await vi.advanceTimersByTimeAsync(3500);

    await expect(promise).resolves.toEqual([]);
    expect(pollCount).toBe(2);
  });

  it("gives up politely at the 15s deadline and still fetches whatever responses are available", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string, options?: any) => {
      if (options?.method === "POST") return { ok: true, json: async () => ({ id: "search-1" }) };
      if (url.endsWith("/responses")) {
        return { ok: true, json: async () => [{ username: "peerB", files: [{ filename: "track.flac", size: 1 }] }] };
      }
      return { ok: true, json: async () => ({ isComplete: false }) }; // never completes
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = searchSlskd(fakeClient(), "never finishes");
    await vi.advanceTimersByTimeAsync(20000);
    const results = await promise;

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("track.flac");
  });

  it("throws when the search-creation request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    await expect(searchSlskd(fakeClient(), "q")).rejects.toThrow("slskd search request failed: HTTP 500");
  });

  it("throws when slskd's create-search response has no search id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

    await expect(searchSlskd(fakeClient(), "q")).rejects.toThrow("slskd did not return a search id");
  });

  it("throws when the final responses fetch fails", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string, options?: any) => {
      if (options?.method === "POST") return { ok: true, json: async () => ({ id: "search-1" }) };
      if (url.endsWith("/responses")) return { ok: false, status: 502 };
      return { ok: true, json: async () => ({ isComplete: true }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = searchSlskd(fakeClient(), "q");
    // Attach the rejection expectation before advancing timers — advanceTimersByTimeAsync can drive
    // the promise all the way to rejection before the next line runs, which would otherwise leave a
    // window where Node sees an unhandled rejection.
    const assertion = expect(promise).rejects.toThrow("slskd search responses request failed: HTTP 502");
    await vi.advanceTimersByTimeAsync(1500);

    await assertion;
  });
});

describe("a shared folder is one result (N17)", () => {
  const stubSearch = (responses: unknown[]) => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: any) => {
        if (options?.method === "POST") return { ok: true, json: async () => ({ id: "s1" }) };
        if (url.endsWith("/responses")) return { ok: true, json: async () => responses };
        return { ok: true, json: async () => ({ isComplete: true }) };
      })
    );
  };

  it("groups the tracks of a folder into one release named by its last two folders, with the format and the folder's size", async () => {
    stubSearch([
      {
        username: "peerA",
        files: [
          { filename: "@@peerA\\Music\\Queen\\Greatest Hits (1981)\\01 Another One Bites the Dust.flac", size: 30_000_000 },
          { filename: "@@peerA\\Music\\Queen\\Greatest Hits (1981)\\02 Bohemian Rhapsody.flac", size: 40_000_000 },
          { filename: "@@peerA\\Music\\Queen\\Greatest Hits (1981)\\cover.jpg", size: 100_000 },
          { filename: "@@peerA\\Music\\Singles\\Lonely Track.mp3", size: 5_000_000 },
        ],
      },
    ]);
    const promise = searchSlskd(fakeClient(), "queen greatest hits");
    await vi.advanceTimersByTimeAsync(3500);
    const results = await promise;

    const folder = results.find((r) => r.title.startsWith("Queen"))!;
    expect(folder.title).toBe("Queen - Greatest Hits (1981) [FLAC]");
    expect(folder.size).toBe(70_000_000);
    const decoded = decodeSlskdFolderUrl(folder.downloadUrl)!;
    expect(decoded.username).toBe("peerA");
    expect(decoded.directory).toBe("@@peerA\\Music\\Queen\\Greatest Hits (1981)");
    expect(decoded.files.map((f) => f.size)).toEqual([30_000_000, 40_000_000]);
    // The picture is not asked for, and a lone track stays a single file.
    expect(decoded.files.every((f) => f.filename.endsWith(".flac"))).toBe(true);
    const single = results.find((r) => r.title === "Lonely Track.mp3")!;
    expect(decodeSlskdFolderUrl(single.downloadUrl)).toBeNull();
    expect(decodeSlskdDownloadUrl(single.downloadUrl).filename).toBe("@@peerA\\Music\\Singles\\Lonely Track.mp3");
  });

  it("tags an MP3 folder with its bitrate when all the tracks share one", async () => {
    stubSearch([
      {
        username: "peerB",
        files: [
          { filename: "Music/Album One/01.mp3", size: 1, bitRate: 320 },
          { filename: "Music/Album One/02.mp3", size: 1, bitRate: 320 },
          { filename: "Music/Album Two/01.mp3", size: 1, bitRate: 320 },
          { filename: "Music/Album Two/02.mp3", size: 1, bitRate: 192 },
        ],
      },
    ]);
    const promise = searchSlskd(fakeClient(), "album");
    await vi.advanceTimersByTimeAsync(3500);
    expect((await promise).map((r) => r.title)).toEqual(["Music - Album One [MP3 320]", "Music - Album Two [MP3]"]);
  });

  it("round-trips a folder url and refuses one that is not a folder", () => {
    const folder = { username: "cool user", directory: "Music\\Café (Live)", files: [{ filename: "Music\\Café (Live)\\01 é.flac", size: 9 }] };
    expect(decodeSlskdFolderUrl(encodeSlskdFolderUrl(folder))).toEqual(folder);
    expect(decodeSlskdFolderUrl(encodeSlskdDownloadUrl("u", "f.mp3", 1))).toBeNull();
    expect(decodeSlskdFolderUrl("not a url")).toBeNull();
    const id = slskdFolderDownloadId(folder);
    expect(parseSlskdFolderDownloadId(id)).toEqual({ username: "cool user", directory: "Music\\Café (Live)", count: 1 });
    expect(parseSlskdFolderDownloadId("someuser song.mp3")).toBeNull();
  });
});
