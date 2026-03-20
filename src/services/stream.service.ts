/**
 * stream.service.ts
 *
 * Returns a streamable URL for an episode.
 *   - S3 mode  → generates a presigned URL (no bandwidth through the backend)
 *   - Local mode → returns a /api/episodes/:id/stream endpoint path (piped through Express)
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';

let s3: S3Client | null = null;

function getS3(): S3Client {
  if (!s3) {
    s3 = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT || undefined,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
      forcePathStyle: !!env.S3_ENDPOINT,
    });
  }
  return s3;
}

export interface StreamInfo {
  type: 'redirect' | 'proxy';
  /** For redirect: the presigned S3 URL. For proxy: the episode's file_path on disk. */
  url: string;
  expiresIn?: number;
}

export async function getStreamInfo(
  filePath: string,
  bucketName: string
): Promise<StreamInfo> {
  if (env.STORAGE_MODE === 's3') {
    const command = new GetObjectCommand({
      Bucket: bucketName || env.S3_BUCKET_NAME,
      Key: filePath,
    });

    const signedUrl = await getSignedUrl(getS3(), command, {
      expiresIn: env.S3_PRESIGN_EXPIRES,
    });

    return { type: 'redirect', url: signedUrl, expiresIn: env.S3_PRESIGN_EXPIRES };
  }

  // Local mode — caller (controller) will pipe the file
  const fullPath = `${env.LOCAL_STORAGE_PATH}/${filePath}`;
  return { type: 'proxy', url: fullPath };
}
