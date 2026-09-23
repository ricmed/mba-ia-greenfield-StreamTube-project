/**
 * Injection tokens for the two S3 clients.
 *
 * SigV4 signs the `host` header, so a URL signed against the in-cluster
 * endpoint is invalid from a browser and vice-versa. The split is the reason
 * the module provides two clients instead of one (phase-03-videos/TD-04).
 */
export const S3_INTERNAL_CLIENT = Symbol('S3_INTERNAL_CLIENT');
export const S3_PUBLIC_CLIENT = Symbol('S3_PUBLIC_CLIENT');

/** Deterministic object keys (phase-03-videos/TD-04). */
export const originalKey = (videoId: string): string =>
  `videos/${videoId}/original`;

export const thumbnailKey = (videoId: string): string =>
  `videos/${videoId}/thumbnail.jpg`;
