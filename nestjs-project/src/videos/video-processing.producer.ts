import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  VIDEO_PROCESSING,
  VideoProcessJobData,
} from './video-processing.constants';

@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING.QUEUE)
    private readonly queue: Queue<VideoProcessJobData>,
  ) {}

  /**
   * Enqueues the processing job **after** the upload transaction commits
   * (phase-03-videos/TD-08). `jobId = videoId` makes re-enqueueing idempotent
   * while the job is still around, so a retried `complete` call never
   * duplicates work (phase-03-videos/TD-01).
   */
  async enqueueProcessing(videoId: string): Promise<void> {
    await this.queue.add(VIDEO_PROCESSING.JOB, { videoId }, { jobId: videoId });
  }
}
