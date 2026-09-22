import { registerAs } from '@nestjs/config';

/**
 * Background job queue (BullMQ over Redis) configuration.
 *
 * See phase-03-videos/TD-01. `attempts` and `backoffDelayMs` drive the retry
 * policy of the video processing job (phase-03-videos/TD-08).
 */
export default registerAs('queue', () => ({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  attempts: parseInt(process.env.VIDEO_JOB_ATTEMPTS || '3', 10),
  backoffDelayMs: parseInt(process.env.VIDEO_JOB_BACKOFF_MS || '2000', 10),
}));
