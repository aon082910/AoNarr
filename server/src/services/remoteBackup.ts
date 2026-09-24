import fs from "node:fs";
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { log } from "./logger.js";
import { getSetting } from "./settingsStore.js";

function getS3Client(): S3Client | null {
  const accessKeyId = getSetting("s3AccessKeyId");
  const secretAccessKey = getSetting("s3SecretAccessKey");
  const region = getSetting("s3Region") || "us-east-1";
  if (!accessKeyId || !secretAccessKey) return null;

  const endpoint = getSetting("s3Endpoint");
  return new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  });
}

/** Uploads a local backup file to the configured S3-compatible bucket (AWS S3, MinIO, Backblaze
 * B2, etc. — anything speaking the S3 API, via an optional custom endpoint) and rotates out the
 * oldest remote objects beyond the keep-count, mirroring the local scheduled-backup rotation.
 * Best-effort: never throws, since this runs unattended alongside the local backup and a remote
 * upload failure shouldn't be treated as the whole backup having failed. */
export async function uploadBackupToRemote(localPath: string, fileName: string, keepCount: number): Promise<void> {
  if (getSetting("s3Enabled") !== "1") return;
  const bucket = getSetting("s3Bucket");
  if (!bucket) {
    log.warn("[backup] remote backup is enabled but no S3 bucket is configured — skipping");
    return;
  }
  const client = getS3Client();
  if (!client) {
    log.warn("[backup] remote backup is enabled but S3 credentials are missing — skipping");
    return;
  }

  const prefix = (getSetting("s3Prefix") || "").replace(/^\/+|\/+$/g, "");
  const key = prefix ? `${prefix}/${fileName}` : fileName;

  try {
    const body = fs.readFileSync(localPath);
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
    log.info(`[backup] uploaded scheduled backup to s3://${bucket}/${key}`);

    // Only direct children of this prefix count: a nested prefix (another instance sharing the
    // bucket, an archive folder) would otherwise be counted as ours, and since full keys sort by
    // their prefix first, rotation could delete this instance's newest backups — even the one just
    // uploaded — while keeping the nested ones.
    const listPrefix = prefix ? `${prefix}/` : "";
    const objects: { key: string; name: string }[] = [];
    let continuationToken: string | undefined;
    do {
      const listed = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: listPrefix || undefined,
          Delimiter: "/",
          ContinuationToken: continuationToken,
        })
      );
      for (const o of listed.Contents ?? []) {
        if (!o.Key || !o.Key.startsWith(listPrefix)) continue;
        const name = o.Key.slice(listPrefix.length);
        // Matches any backup this instance has ever produced under this prefix — bundles (current),
        // and legacy single-file .db/.dump backups from before bundling existed — not just the
        // extension of the file just uploaded, so rotation still counts and trims all of them together.
        // Requires the "aonarr-backup-" filename prefix too (matching scheduledBackup.ts's identical
        // local-rotation filter), not just a matching extension — an S3 prefix is often a whole bucket
        // path an admin also uses for other things, and a bare extension check would let rotation
        // delete unrelated .db/.dump files sitting under the same prefix.
        if (!name.includes("/") && name.startsWith("aonarr-backup-") && /\.(aonarrbackup|db|dump)$/.test(name)) {
          objects.push({ key: o.Key, name });
        }
      }
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
    objects.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const toDelete = objects.slice(0, Math.max(0, objects.length - keepCount));
    for (const obj of toDelete) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.key }));
      log.info(`[backup] rotated out old remote backup ${obj.key}`);
    }
  } catch (err) {
    log.error("[backup] remote backup upload failed:", (err as Error).message);
  }
}
