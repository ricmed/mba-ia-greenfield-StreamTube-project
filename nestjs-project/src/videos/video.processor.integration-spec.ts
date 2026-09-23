import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { originalKey } from '../storage/storage.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  ALL_ENTITIES,
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  createCorruptFixture,
  createVideoFixture,
} from '../test/video-fixture';
import { User } from '../users/entities/user.entity';
import {
  Video,
  VideoProcessingStatus,
  VideoStatus,
} from './entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { VIDEO_PROCESSING } from './video-processing.constants';
import { VideoProcessor } from './video.processor';

describe('VideoProcessor (integration)', () => {
  let module: TestingModule;
  let processor: VideoProcessor;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let counter = 0;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (config: ReturnType<typeof queueConfig>) => ({
            connection: {
              host: config.host,
              port: config.port,
              maxRetriesPerRequest: null,
            },
          }),
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESSING.QUEUE }),
        StorageModule,
      ],
      providers: [VideoProcessor, FfmpegService],
    }).compile();

    await module.init();
    processor = module.get(VideoProcessor);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING.QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  /** Persists a video in `processing` whose original is already in the storage. */
  async function seedProcessingVideo(body: Buffer): Promise<Video> {
    const user = await dataSource.getRepository(User).save({
      email: `processor_${++counter}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: `processor_${counter}`,
      nickname: `processor_${counter}`,
      user_id: user.id,
    });

    const id = randomUUID();
    const storage_key = originalKey(id);
    await storage.putObject(storage_key, body, 'video/mp4');

    return videoRepository.save(
      videoRepository.create({
        id,
        public_id: `proc${counter.toString().padStart(7, '0')}`,
        channel_id: channel.id,
        title: 'Processor video',
        status: VideoStatus.DRAFT,
        processing_status: VideoProcessingStatus.PROCESSING,
        storage_key,
        original_filename: 'processor.mp4',
        mime_type: 'video/mp4',
        size_bytes: String(body.length),
      }),
    );
  }

  const jobFor = (videoId: string): Job<{ videoId: string }> =>
    ({
      data: { videoId },
      opts: { attempts: 3 },
      attemptsMade: 0,
    }) as Job<{ videoId: string }>;

  it('should extract metadata, store the thumbnail and mark the video ready', async () => {
    const video = await seedProcessingVideo(
      await createVideoFixture({ durationSeconds: 2 }),
    );

    await processor.process(jobFor(video.id));

    const processed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(processed.processing_status).toBe(VideoProcessingStatus.READY);
    expect(processed.duration_seconds).toBe(2);
    expect(processed.metadata?.width).toBe(320);
    expect(processed.metadata?.video_codec).toBe('h264');
    expect(processed.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
    expect(processed.processing_error).toBeNull();

    const thumbnail = await storage.headObject(processed.thumbnail_key!);
    expect(thumbnail.contentLength).toBeGreaterThan(0);
  });

  it('should keep the editorial status as draft', async () => {
    const video = await seedProcessingVideo(await createVideoFixture());

    await processor.process(jobFor(video.id));

    const processed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(processed.status).toBe(VideoStatus.DRAFT);
  });

  it('should mark a non-video file as failed without retrying', async () => {
    const video = await seedProcessingVideo(createCorruptFixture());

    await expect(processor.process(jobFor(video.id))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    const processed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(processed.processing_status).toBe(VideoProcessingStatus.FAILED);
    expect(processed.processing_error).toBeTruthy();
  });

  it('should be idempotent: reprocessing overwrites metadata and thumbnail', async () => {
    const video = await seedProcessingVideo(
      await createVideoFixture({ durationSeconds: 2 }),
    );

    await processor.process(jobFor(video.id));
    const first = await videoRepository.findOneByOrFail({ id: video.id });

    await videoRepository.update(
      { id: video.id },
      { processing_status: VideoProcessingStatus.PROCESSING },
    );
    await processor.process(jobFor(video.id));
    const second = await videoRepository.findOneByOrFail({ id: video.id });

    expect(second.thumbnail_key).toBe(first.thumbnail_key);
    expect(second.processing_status).toBe(VideoProcessingStatus.READY);
    expect(second.duration_seconds).toBe(first.duration_seconds);
  });

  it('should not retry a job whose video no longer exists', async () => {
    await expect(
      processor.process(jobFor(randomUUID())),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('should persist the failure only on the last attempt', async () => {
    const video = await seedProcessingVideo(await createVideoFixture());
    const job = {
      data: { videoId: video.id },
      opts: { attempts: 3 },
      attemptsMade: 1,
    } as Job<{ videoId: string }>;

    await processor.onFailed(job, new Error('transient storage blip'));
    let current = await videoRepository.findOneByOrFail({ id: video.id });
    expect(current.processing_status).toBe(VideoProcessingStatus.PROCESSING);

    job.attemptsMade = 3;
    await processor.onFailed(job, new Error('transient storage blip'));
    current = await videoRepository.findOneByOrFail({ id: video.id });
    expect(current.processing_status).toBe(VideoProcessingStatus.FAILED);
    expect(current.processing_error).toContain('transient storage blip');
  });
});
