import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { VideoMetadata } from './entities/video.entity';

const execFileAsync = promisify(execFile);

/** Raised when the source is not a media file ffprobe can read — never retried. */
export class InvalidVideoFileError extends Error {
  constructor(details: string) {
    super(`Source file is not a readable video: ${details}`);
    this.name = 'InvalidVideoFileError';
  }
}

export interface ProbeResult {
  durationSeconds: number | null;
  metadata: VideoMetadata;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; bit_rate?: string; format_name?: string };
}

const MAX_THUMBNAIL_WIDTH = 1280;
const THUMBNAIL_POSITION_RATIO = 0.1;
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Wraps the system ffmpeg/ffprobe binaries (phase-03-videos/TD-07).
 *
 * Both read the source straight from a presigned URL: ffmpeg seeks over HTTP
 * range requests, so a 10GB original is never downloaded to disk.
 */
@Injectable()
export class FfmpegService {
  private readonly logger = new Logger(FfmpegService.name);

  async probe(sourceUrl: string): Promise<ProbeResult> {
    let stdout: string;

    try {
      ({ stdout } = await execFileAsync(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          sourceUrl,
        ],
        { maxBuffer: MAX_BUFFER },
      ));
    } catch (err) {
      throw new InvalidVideoFileError(
        (err as { stderr?: string }).stderr?.trim() || (err as Error).message,
      );
    }

    const probed = JSON.parse(stdout) as FfprobeOutput;
    const video = probed.streams?.find((s) => s.codec_type === 'video');

    if (!video) {
      throw new InvalidVideoFileError('no video stream found');
    }

    const duration = Number(probed.format?.duration);

    return {
      durationSeconds: Number.isFinite(duration) ? Math.round(duration) : null,
      metadata: {
        width: video.width ?? null,
        height: video.height ?? null,
        video_codec: video.codec_name ?? null,
        audio_codec:
          probed.streams?.find((s) => s.codec_type === 'audio')?.codec_name ??
          null,
        bitrate: Number(probed.format?.bit_rate) || null,
        format: probed.format?.format_name ?? null,
      },
    };
  }

  /**
   * Grabs a single frame as JPEG. The frame is taken at 10% of the duration so
   * the thumbnail is not the (often black) first frame.
   */
  async extractThumbnail(
    sourceUrl: string,
    durationSeconds: number | null,
  ): Promise<Buffer> {
    const position = durationSeconds
      ? Math.max(0, Math.floor(durationSeconds * THUMBNAIL_POSITION_RATIO))
      : 0;

    const { stdout } = await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        // -ss before -i makes ffmpeg seek instead of decoding from the start.
        '-ss',
        String(position),
        '-i',
        sourceUrl,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${MAX_THUMBNAIL_WIDTH},iw)':-2`,
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      { maxBuffer: MAX_BUFFER, encoding: 'buffer' },
    );

    if (!stdout.length) {
      throw new InvalidVideoFileError('ffmpeg produced no frame');
    }

    this.logger.debug(`Extracted thumbnail at ${position}s`);
    return stdout;
  }
}
