import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestDb } from "./helpers/testDb.js";

let app: Express;
let db: Awaited<ReturnType<typeof setupTestDb>>["db"];
let apiKey: string;

async function householdUser(username: string, allowedTypes: string[], autoApprove = false): Promise<{ userId: number; token: string }> {
  const { createSession, hashPassword } = await import("../src/services/auth.js");
  const userId = Number(
    (
      await db
        .prepare(`INSERT INTO users (username, password_hash, role, auto_approve) VALUES (?, ?, 'user', ?)`)
        .run(username, hashPassword("x"), autoApprove ? 1 : 0)
    ).lastInsertRowid
  );
  for (const type of allowedTypes) {
    await db.prepare("INSERT INTO user_library_access (user_id, media_type) VALUES (?, ?)").run(userId, type);
  }
  return { userId, token: (await createSession(userId)).token };
}

async function insertRequest(userId: number, title: string, status: "pending" | "approved" | "rejected"): Promise<number> {
  return Number(
    (await db.prepare("INSERT INTO requests (user_id, type, title, status) VALUES (?, 'movie', ?, ?)").run(userId, title, status)).lastInsertRowid
  );
}

describe("requests routes", () => {
  beforeAll(async () => {
    ({ app, db, apiKey } = await setupTestDb());
  });

  describe("POST /api/requests", () => {
    it("403s a request for a library type the household account can't access, without recording it", async () => {
      const { token } = await householdUser("requests-movie-only", ["movie"]);

      const res = await request(app).post("/api/requests").set("X-Session-Token", token).send({ type: "series", title: "Forbidden Show" });

      expect(res.status).toBe(403);
      expect(await db.prepare("SELECT id FROM requests WHERE title = 'Forbidden Show'").get()).toBeUndefined();
    });

    it("never auto-approves a disallowed type into the library, even for an auto-approve account", async () => {
      const { token } = await householdUser("requests-auto-approve", ["movie"], true);

      const res = await request(app).post("/api/requests").set("X-Session-Token", token).send({ type: "series", title: "Auto Approve Show" });

      expect(res.status).toBe(403);
      expect(await db.prepare("SELECT id FROM media_items WHERE title = 'Auto Approve Show'").get()).toBeUndefined();
    });

    it("still accepts a request for an allowed type", async () => {
      const { token } = await householdUser("requests-allowed", ["movie"]);

      const res = await request(app).post("/api/requests").set("X-Session-Token", token).send({ type: "movie", title: "Allowed Movie" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ type: "movie", title: "Allowed Movie", status: "pending" });
    });

    it("drops a client-supplied podcast feed URL but keeps the other external ids", async () => {
      const { token } = await householdUser("requests-podcast-feed", ["podcast", "movie"]);

      const podcast = await request(app)
        .post("/api/requests")
        .set("X-Session-Token", token)
        .send({ type: "podcast", title: "Feed Show", externalIds: { podcastFeed: "http://169.254.169.254/latest/meta-data/" } });
      const movie = await request(app)
        .post("/api/requests")
        .set("X-Session-Token", token)
        .send({ type: "movie", title: "Id Movie", externalIds: { tmdb: "603", podcastFeed: "data:application/rss+xml,<rss/>" } });

      expect(podcast.status).toBe(201);
      expect(podcast.body.externalIds).toBeNull();
      expect(movie.status).toBe(201);
      expect(JSON.parse(movie.body.externalIds)).toEqual({ tmdb: "603" });
    });

    it("keeps a metadata poster but drops one the server shouldn't fetch, on the request and on its item", async () => {
      const { token } = await householdUser("requests-poster", ["movie"], true);
      const tmdbPoster = "https://image.tmdb.org/t/p/w342/abc123.jpg";

      const metadataHost = await request(app)
        .post("/api/requests")
        .set("X-Session-Token", token)
        .send({ type: "movie", title: "Metadata Host Poster", posterUrl: "http://169.254.169.254/latest/meta-data/" });
      const tmdb = await request(app)
        .post("/api/requests")
        .set("X-Session-Token", token)
        .send({ type: "movie", title: "Tmdb Poster", posterUrl: tmdbPoster });

      expect(metadataHost.status).toBe(201);
      expect(metadataHost.body.status).toBe("approved");
      expect(metadataHost.body.posterUrl).toBeNull();
      const blockedItem = (await db.prepare("SELECT poster_url FROM media_items WHERE id = ?").get(metadataHost.body.mediaItemId)) as any;
      expect(blockedItem.poster_url).toBeNull();

      expect(tmdb.status).toBe(201);
      expect(tmdb.body.posterUrl).toBe(tmdbPoster);
      const keptItem = (await db.prepare("SELECT poster_url FROM media_items WHERE id = ?").get(tmdb.body.mediaItemId)) as any;
      expect(keptItem.poster_url).toBe(tmdbPoster);

      for (const posterUrl of ["data:image/png;base64,AAAA", "https://10.0.0.5/admin", "http://image.tmdb.org/t/p/w342/x.jpg", "https://image.tmdb.org.evil.test/x.jpg"]) {
        const res = await request(app)
          .post("/api/requests")
          .set("X-Session-Token", token)
          .send({ type: "movie", title: `Rejected Poster ${posterUrl}`, posterUrl });
        expect(res.status).toBe(201);
        expect(res.body.posterUrl).toBeNull();
      }
    });

    it("gives an auto-approved item the default quality profile instead of none", async () => {
      const defaultId = Number(((await db.prepare("SELECT id FROM quality_profiles ORDER BY id LIMIT 1").get()) as any).id);
      const { token } = await householdUser("requests-profile-auto", ["movie"], true);

      const res = await request(app).post("/api/requests").set("X-Session-Token", token).send({ type: "movie", title: "Auto Profile Movie" });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("approved");
      const item = (await db.prepare("SELECT quality_profile_id FROM media_items WHERE id = ?").get(res.body.mediaItemId)) as any;
      expect(item.quality_profile_id).not.toBeNull();
      expect(Number(item.quality_profile_id)).toBe(defaultId);
    });

    it("never puts a podcast feed on the library item an auto-approved request creates", async () => {
      const { token } = await householdUser("requests-podcast-auto", ["podcast"], true);

      const res = await request(app)
        .post("/api/requests")
        .set("X-Session-Token", token)
        .send({ type: "podcast", title: "Auto Feed Show", externalIds: { podcastFeed: "http://127.0.0.1:8080/feed.xml" } });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("approved");
      const item = (await db.prepare("SELECT external_ids, monitored FROM media_items WHERE id = ?").get(res.body.mediaItemId)) as any;
      expect(item.monitored).toBe(1);
      expect(item.external_ids).toBeNull();
    });

    it("lets only one of several simultaneous submissions through a max-1 pending quota", async () => {
      const { userId, token } = await householdUser("requests-quota-race", ["movie"]);
      await db.prepare("UPDATE users SET max_pending_requests = 1 WHERE id = ?").run(userId);

      const responses = await Promise.all(
        [1, 2, 3, 4, 5].map((n) =>
          request(app).post("/api/requests").set("X-Session-Token", token).send({ type: "movie", title: `Quota Race Movie ${n}` })
        )
      );

      expect(responses.map((r) => r.status).sort()).toEqual([201, 400, 400, 400, 400]);
      const pending = (await db.prepare("SELECT COUNT(*) AS c FROM requests WHERE user_id = ? AND status = 'pending'").get(userId)) as any;
      expect(Number(pending.c)).toBe(1);
    });

    it("records only one of several simultaneous submissions of the same title", async () => {
      const { userId, token } = await householdUser("requests-duplicate-race", ["movie"]);

      const responses = await Promise.all(
        [1, 2, 3, 4].map(() =>
          request(app).post("/api/requests").set("X-Session-Token", token).send({ type: "movie", title: "Double Submit Movie" })
        )
      );

      expect(responses.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
      const rows = (await db.prepare("SELECT COUNT(*) AS c FROM requests WHERE user_id = ?").get(userId)) as any;
      expect(Number(rows.c)).toBe(1);
    });

    it("adds only one library item when several auto-approve accounts submit the same title at once", async () => {
      const tokens = await Promise.all(
        [1, 2, 3, 4].map(async (n) => (await householdUser(`requests-cross-race-${n}`, ["movie"], true)).token)
      );

      const responses = await Promise.all(
        tokens.map((token) =>
          request(app).post("/api/requests").set("X-Session-Token", token).send({ type: "movie", title: "Cross User Race" })
        )
      );

      expect(responses.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
      const requests = (await db.prepare("SELECT COUNT(*) AS c FROM requests WHERE title = 'Cross User Race'").get()) as any;
      const items = (await db.prepare("SELECT COUNT(*) AS c FROM media_items WHERE title = 'Cross User Race'").get()) as any;
      expect(Number(requests.c)).toBe(1);
      expect(Number(items.c)).toBe(1);
    });
  });

  describe("POST /api/requests/:id/approve", () => {
    it("drops a podcast feed stored on an older request instead of copying it onto the library item", async () => {
      const { userId } = await householdUser("requests-legacy-feed", ["podcast"]);
      const id = Number(
        (
          await db
            .prepare("INSERT INTO requests (user_id, type, title, external_ids) VALUES (?, 'podcast', 'Legacy Feed Show', ?)")
            .run(userId, JSON.stringify({ podcastFeed: "http://10.0.0.1/feed.xml" }))
        ).lastInsertRowid
      );

      const res = await request(app).post(`/api/requests/${id}/approve`).set("X-Api-Key", apiKey).send({});

      expect(res.status).toBe(200);
      const item = (await db.prepare("SELECT external_ids FROM media_items WHERE id = ?").get(res.body.mediaItemId)) as any;
      expect(item.external_ids).toBeNull();
    });

    it("adds the item once when the same request is approved twice at the same time", async () => {
      const { userId } = await householdUser("requests-double-approve", ["movie"]);
      const id = await insertRequest(userId, "Double Approve Movie", "pending");

      const responses = await Promise.all(
        [1, 2].map(() => request(app).post(`/api/requests/${id}/approve`).set("X-Api-Key", apiKey).send({}))
      );

      expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
      const items = (await db.prepare("SELECT COUNT(*) AS c FROM media_items WHERE title = 'Double Approve Movie'").get()) as any;
      expect(Number(items.c)).toBe(1);
    });

    it("gives the item the default quality profile when the admin doesn't pick one, and keeps one they do pick", async () => {
      const { userId } = await householdUser("requests-profile-admin", ["movie"]);
      const defaultId = Number(((await db.prepare("SELECT id FROM quality_profiles ORDER BY id LIMIT 1").get()) as any).id);
      const pickedId = Number(
        (
          await db
            .prepare("INSERT INTO quality_profiles (name, allowed_qualities, cutoff) VALUES (?, ?, ?)")
            .run("Requests Picked Profile", JSON.stringify(["WEBDL-1080p"]), "WEBDL-1080p")
        ).lastInsertRowid
      );
      const unpicked = await insertRequest(userId, "Unpicked Profile Movie", "pending");
      const picked = await insertRequest(userId, "Picked Profile Movie", "pending");

      const unpickedRes = await request(app).post(`/api/requests/${unpicked}/approve`).set("X-Api-Key", apiKey).send({ confirmDuplicate: false });
      const pickedRes = await request(app).post(`/api/requests/${picked}/approve`).set("X-Api-Key", apiKey).send({ qualityProfileId: pickedId });

      expect(unpickedRes.status).toBe(200);
      expect(Number(unpickedRes.body.mediaItem.qualityProfileId)).toBe(defaultId);
      expect(pickedRes.status).toBe(200);
      expect(Number(pickedRes.body.mediaItem.qualityProfileId)).toBe(pickedId);
    });

    it("drops a stored poster the server shouldn't fetch instead of copying it onto the library item", async () => {
      const { userId } = await householdUser("requests-legacy-poster", ["movie"]);
      const id = Number(
        (
          await db
            .prepare("INSERT INTO requests (user_id, type, title, poster_url) VALUES (?, 'movie', 'Legacy Poster Movie', ?)")
            .run(userId, "http://169.254.169.254/latest/meta-data/")
        ).lastInsertRowid
      );

      const res = await request(app).post(`/api/requests/${id}/approve`).set("X-Api-Key", apiKey).send({});

      expect(res.status).toBe(200);
      expect(res.body.mediaItem.posterUrl).toBeNull();
    });

    it("lets exactly one of an approve and a reject sent together win", async () => {
      const { userId } = await householdUser("requests-approve-reject-race", ["movie"]);
      for (let n = 0; n < 5; n++) {
        const title = `Approve Reject Race ${n}`;
        const id = await insertRequest(userId, title, "pending");

        const [approve, reject] = await Promise.all([
          request(app).post(`/api/requests/${id}/approve`).set("X-Api-Key", apiKey).send({}),
          request(app).post(`/api/requests/${id}/reject`).set("X-Api-Key", apiKey),
        ]);

        const row = (await db.prepare("SELECT status FROM requests WHERE id = ?").get(id)) as any;
        const items = Number(((await db.prepare("SELECT COUNT(*) AS c FROM media_items WHERE title = ?").get(title)) as any).c);
        if (approve.status === 200) {
          expect(reject.status).toBe(400);
          expect(row.status).toBe("approved");
          expect(items).toBe(1);
        } else {
          expect([400, 409]).toContain(approve.status);
          expect(reject.status).toBe(200);
          expect(row.status).toBe("rejected");
          expect(items).toBe(0);
        }
      }
    });

    it("lets exactly one of an approve and the requester's cancel sent together win", async () => {
      const { userId, token } = await householdUser("requests-approve-cancel-race", ["movie"]);
      for (let n = 0; n < 5; n++) {
        const title = `Approve Cancel Race ${n}`;
        const id = await insertRequest(userId, title, "pending");

        const [approve, cancel] = await Promise.all([
          request(app).post(`/api/requests/${id}/approve`).set("X-Api-Key", apiKey).send({}),
          request(app).delete(`/api/requests/${id}`).set("X-Session-Token", token),
        ]);

        const row = (await db.prepare("SELECT status FROM requests WHERE id = ?").get(id)) as any;
        const items = Number(((await db.prepare("SELECT COUNT(*) AS c FROM media_items WHERE title = ?").get(title)) as any).c);
        if (approve.status === 200) {
          expect(cancel.status).toBe(400);
          expect(row.status).toBe("approved");
          expect(items).toBe(1);
        } else {
          expect([404, 409]).toContain(approve.status);
          expect(cancel.status).toBe(204);
          expect(row).toBeUndefined();
          expect(items).toBe(0);
        }
      }
    });

    it("rolls the new item back when the request stops being pending mid-approval", async () => {
      const { userId } = await householdUser("requests-resolved-meanwhile", ["movie"]);
      const id = await insertRequest(userId, "Resolved Meanwhile Movie", "pending");
      // Stands in for a reject or cancel committed between the pending check and the approval's UPDATE.
      if (db.dialect === "postgres") {
        await db.exec(
          `CREATE FUNCTION reject_on_item_insert() RETURNS trigger AS $$
           BEGIN UPDATE requests SET status = 'rejected' WHERE title = NEW.title; RETURN NEW; END;
           $$ LANGUAGE plpgsql`
        );
        await db.exec(
          `CREATE TRIGGER reject_on_item_insert AFTER INSERT ON media_items FOR EACH ROW
           WHEN (NEW.title = 'Resolved Meanwhile Movie') EXECUTE FUNCTION reject_on_item_insert()`
        );
      } else {
        await db.exec(
          `CREATE TRIGGER reject_on_item_insert AFTER INSERT ON media_items WHEN NEW.title = 'Resolved Meanwhile Movie'
           BEGIN UPDATE requests SET status = 'rejected' WHERE title = NEW.title; END`
        );
      }
      try {
        const res = await request(app).post(`/api/requests/${id}/approve`).set("X-Api-Key", apiKey).send({});

        expect(res.status).toBe(409);
        const items = (await db.prepare("SELECT COUNT(*) AS c FROM media_items WHERE title = 'Resolved Meanwhile Movie'").get()) as any;
        expect(Number(items.c)).toBe(0);
        const row = (await db.prepare("SELECT status, media_item_id FROM requests WHERE id = ?").get(id)) as any;
        expect(row.media_item_id).toBeNull();
      } finally {
        if (db.dialect === "postgres") {
          await db.exec("DROP TRIGGER reject_on_item_insert ON media_items");
          await db.exec("DROP FUNCTION reject_on_item_insert()");
        } else {
          await db.exec("DROP TRIGGER reject_on_item_insert");
        }
      }
    });
  });

  describe("DELETE /api/requests/:id", () => {
    it("lets the requester cancel a pending request but not remove an approved one", async () => {
      const { userId, token } = await householdUser("requests-canceller", ["movie"]);
      const pending = await insertRequest(userId, "Cancel Pending Movie", "pending");
      const approved = await insertRequest(userId, "Cancel Approved Movie", "approved");

      const cancelPending = await request(app).delete(`/api/requests/${pending}`).set("X-Session-Token", token);
      const cancelApproved = await request(app).delete(`/api/requests/${approved}`).set("X-Session-Token", token);

      expect(cancelPending.status).toBe(204);
      expect(await db.prepare("SELECT id FROM requests WHERE id = ?").get(pending)).toBeUndefined();
      expect(cancelApproved.status).toBe(400);
      expect(await db.prepare("SELECT id FROM requests WHERE id = ?").get(approved)).toBeDefined();
    });

    it("still lets an admin delete a resolved request", async () => {
      const { userId } = await householdUser("requests-admin-delete", ["movie"]);
      const approved = await insertRequest(userId, "Admin Delete Movie", "approved");

      const res = await request(app).delete(`/api/requests/${approved}`).set("X-Api-Key", apiKey);

      expect(res.status).toBe(204);
      expect(await db.prepare("SELECT id FROM requests WHERE id = ?").get(approved)).toBeUndefined();
    });
  });

  describe("GET /api/requests/stats", () => {
    it("stops counting an approved item's size once its file is gone", async () => {
      const { userId } = await householdUser("requests-storage", ["movie"]);
      const withFile = Number(
        (
          await db
            .prepare("INSERT INTO media_items (type, title, sort_title, has_file, size_bytes) VALUES ('movie', 'Stored Movie', 'stored movie', 1, 5000)")
            .run()
        ).lastInsertRowid
      );
      const archived = Number(
        (
          await db
            .prepare("INSERT INTO media_items (type, title, sort_title, has_file, size_bytes) VALUES ('movie', 'Archived Movie', 'archived movie', 0, 30000)")
            .run()
        ).lastInsertRowid
      );
      for (const [title, mediaItemId] of [
        ["Stored Movie", withFile],
        ["Archived Movie", archived],
      ] as const) {
        await db
          .prepare("INSERT INTO requests (user_id, type, title, status, media_item_id) VALUES (?, 'movie', ?, 'approved', ?)")
          .run(userId, title, mediaItemId);
      }

      const res = await request(app).get("/api/requests/stats").set("X-Api-Key", apiKey);

      expect(res.status).toBe(200);
      expect(res.body.find((s: any) => s.userId === userId).storageBytes).toBe(5000);
    });
  });

  describe("POST /api/requests/:id/reject", () => {
    let requesterId: number;

    beforeAll(async () => {
      ({ userId: requesterId } = await householdUser("requests-rejectee", ["movie"]));
    });

    it("rejects a pending request", async () => {
      const id = await insertRequest(requesterId, "Pending Reject Movie", "pending");

      const res = await request(app).post(`/api/requests/${id}/reject`).set("X-Api-Key", apiKey);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("rejected");
    });

    it("400s for an already-approved request and leaves it approved", async () => {
      const id = await insertRequest(requesterId, "Approved Movie", "approved");
      const before = (await db.prepare("SELECT status, resolved_at FROM requests WHERE id = ?").get(id)) as any;

      const res = await request(app).post(`/api/requests/${id}/reject`).set("X-Api-Key", apiKey);

      expect(res.status).toBe(400);
      expect(await db.prepare("SELECT status, resolved_at FROM requests WHERE id = ?").get(id)).toEqual(before);
      expect(before.status).toBe("approved");
    });

    it("400s for an already-rejected request", async () => {
      const id = await insertRequest(requesterId, "Rejected Movie", "rejected");

      const res = await request(app).post(`/api/requests/${id}/reject`).set("X-Api-Key", apiKey);

      expect(res.status).toBe(400);
    });

    it("404s for a request that doesn't exist", async () => {
      const res = await request(app).post("/api/requests/999999/reject").set("X-Api-Key", apiKey);
      expect(res.status).toBe(404);
    });
  });
});
