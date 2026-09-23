import { randomBytes } from 'crypto';
import { QueryFailedError } from 'typeorm';

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_COLUMN = 'public_id';
const MAX_RETRIES = 5;

/** 8 random bytes → 11 base64url chars (64 bits, phase-03-videos/TD-09). */
export function generatePublicId(): string {
  return randomBytes(8).toString('base64url');
}

// TypeORM copies the pg driver error fields (code, detail) onto QueryFailedError.
interface PgErrorFields {
  code?: unknown;
  detail?: unknown;
}

export function isPublicIdConflict(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const { code, detail } = err as QueryFailedError & PgErrorFields;
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(PUBLIC_ID_COLUMN)
  );
}

/**
 * Persists using a freshly generated public_id, retrying when the unique index
 * rejects it. Mirrors the nickname strategy of `ChannelsService`
 * (phase-02-auth/TD-10) applied to video URLs (phase-03-videos/TD-09).
 */
export async function persistWithUniquePublicId<T>(
  persist: (publicId: string) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await persist(generatePublicId());
    } catch (err) {
      if (!isPublicIdConflict(err)) throw err;
    }
  }

  throw new Error('public_id conflict could not be resolved after max retries');
}
