import { registerAs } from '@nestjs/config';

/**
 * Object storage (S3-compatible) configuration.
 *
 * `endpoint` is the in-cluster address used for every server-side call (API and
 * worker). `publicEndpoint` is used ONLY to sign URLs handed to clients: SigV4
 * signs the `host` header, so a URL signed for the internal service name is not
 * valid from a browser. See phase-03-videos/TD-04.
 */
export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.S3_REGION || 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY || 'streamtube',
  secretKey: process.env.S3_SECRET_KEY || 'streamtube',
  bucket: process.env.S3_BUCKET || 'streamtube-videos',
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
  maxUploadSizeBytes: parseInt(
    process.env.VIDEO_MAX_SIZE_BYTES || '10737418240',
    10,
  ),
  partSizeBytes: parseInt(process.env.VIDEO_PART_SIZE_BYTES || '67108864', 10),
  urlExpirationSeconds: parseInt(
    process.env.VIDEO_URL_EXPIRATION_SECONDS || '3600',
    10,
  ),
}));
