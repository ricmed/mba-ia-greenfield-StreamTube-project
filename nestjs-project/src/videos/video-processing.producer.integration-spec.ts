import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING } from './video-processing.constants';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingProducer (integration)', () => {
  let module: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (config: ReturnType<typeof queueConfig>) => ({
            connection: {
              host: config.host,
              port: config.port,
              maxRetriesPerRequest: null,
            },
            defaultJobOptions: {
              attempts: config.attempts,
              backoff: { type: 'exponential', delay: config.backoffDelayMs },
              removeOnComplete: true,
            },
          }),
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESSING.QUEUE }),
      ],
      providers: [VideoProcessingProducer],
    }).compile();

    await module.init();
    producer = module.get(VideoProcessingProducer);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING.QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  it('should enqueue a job carrying the video id', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessing(videoId);

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe(VIDEO_PROCESSING.JOB);
    expect(jobs[0].data).toEqual({ videoId });
  });

  it('should keep a single pending job when the same video is enqueued twice', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessing(videoId);
    await producer.enqueueProcessing(videoId);

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(videoId);
  });

  it('should apply the retry policy from the queue configuration', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessing(videoId);

    const job = await queue.getJob(videoId);
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 2000 });
  });
});
