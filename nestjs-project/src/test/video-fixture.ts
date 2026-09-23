import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Builds a real (tiny) MP4 with ffmpeg's synthetic sources, so processing
 * tests run against an actual video instead of a checked-in binary
 * (phase-03-videos/TD-12).
 */
export async function createVideoFixture(
  options: { durationSeconds?: number; width?: number; height?: number } = {},
): Promise<Buffer> {
  const { durationSeconds = 2, width = 320, height = 240 } = options;
  const path = join(tmpdir(), `fixture-${randomUUID()}.mp4`);

  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc=duration=${durationSeconds}:size=${width}x${height}:rate=10`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${durationSeconds}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      path,
    ]);

    return await readFile(path);
  } finally {
    await rm(path, { force: true });
  }
}

/** Bytes that are definitely not a video — drives the unrecoverable path. */
export function createCorruptFixture(): Buffer {
  return Buffer.from('this is not a video file, not even close');
}
