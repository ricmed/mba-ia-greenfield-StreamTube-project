import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { thumbnailKey } from '../storage/storage.constants';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import { FfmpegService, InvalidVideoFileError } from './ffmpeg.service';
import {
  VIDEO_PROCESSING,
  VideoProcessJobData,
} from './video-processing.constants';

/**
 * Consumes `video.process` jobs: extracts duration/metadata, generates the
 * thumbnail and moves the video to `ready` (phase-03-videos/TD-07,
 * phase-03-videos/TD-08).
 *
 * Runs in the `video-worker` container, never in the API process
 * (phase-03-videos/TD-06).
 */
@Processor(VIDEO_PROCESSING.QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videoRepository.findOneBy({ id: videoId });

    if (!video) {
      // The draft was deleted (aborted upload) — nothing to process, and
      // retrying would never succeed.
      throw new UnrecoverableError(`Video ${videoId} no longer exists`);
    }

    const sourceUrl = await this.storageService.presignInternalGetObject(
      video.storage_key,
    );

    try {
      const { durationSeconds, metadata } =
        await this.ffmpegService.probe(sourceUrl);
      const thumbnail = await this.ffmpegService.extractThumbnail(
        sourceUrl,
        durationSeconds,
      );

      const key = thumbnailKey(video.id);
      await this.storageService.putObject(key, thumbnail, 'image/jpeg');

      // Deterministic keys make reprocessing idempotent: the same object is
      // overwritten instead of piling up (phase-03-videos/TD-04).
      await this.videoRepository.update(
        { id: video.id },
        {
          duration_seconds: durationSeconds,
          metadata,
          thumbnail_key: key,
          processing_status: VideoProcessingStatus.READY,
          processing_error: null,
        },
      );

      this.logger.log(`Video ${video.public_id} is ready`);
    } catch (err) {
      if (err instanceof InvalidVideoFileError) {
        // Not recoverable: retrying the same corrupt file cannot succeed.
        await this.markFailed(videoId, err.message);
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  }

  /**
   * Records transient failures that ran out of retries.
   *
   * Unrecoverable ones are skipped on purpose: `process()` already wrote the
   * reason before giving up, or — when the draft was deleted mid-flight —
   * there is no row left to write it on. Updating again here would repeat the
   * write and, because this handler is not awaited by the job, it would run
   * after whoever awaited that job already moved on.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<VideoProcessJobData>, err: Error): Promise<void> {
    if (err instanceof UnrecoverableError) return;

    const attempts = job.opts.attempts ?? 1;

    if (job.attemptsMade < attempts) {
      this.logger.warn(
        `Processing of ${job.data.videoId} failed (attempt ${job.attemptsMade}/${attempts}); will retry: ${err.message}`,
      );
      return;
    }

    await this.markFailed(job.data.videoId, err.message);
  }

  private async markFailed(videoId: string, reason: string): Promise<void> {
    await this.videoRepository.update(
      { id: videoId },
      {
        processing_status: VideoProcessingStatus.FAILED,
        processing_error: reason.slice(0, 1000),
      },
    );
    this.logger.error(`Video ${videoId} processing failed: ${reason}`);
  }
}
