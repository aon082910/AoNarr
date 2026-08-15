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

    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix ? `${prefix}/` : undefined })
    );
    const objects = (listed.Contents ?? [])
      .filter((o) => o.Key?.endsWith(".db"))
      .sort((a, b) => (a.Key! < b.Key! ? -1 : 1));
    const toDelete = objects.slice(0, Math.max(0, objects.length - keepCount));
    for (const obj of toDelete) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key! }));
      log.info(`[backup] rotated out old remote backup ${obj.Key}`);
    }
  } catch (err) {
    log.error("[backup] remote backup upload failed:", (err as Error).message);
  }
}
