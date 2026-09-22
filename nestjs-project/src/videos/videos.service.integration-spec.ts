import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import appConfig from '../config/app.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { fetchSignedUrl } from '../test/signed-url';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import {
  Video,
  VideoProcessingStatus,
  VideoStatus,
} from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VIDEO_PROCESSING } from './video-processing.constants';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService — createDraft (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
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
          load: [appConfig, storageConfig, queueConfig],
        }),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (queue: ReturnType<typeof queueConfig>) => ({
            connection: {
              host: queue.host,
              port: queue.port,
              maxRetriesPerRequest: null,
            },
            defaultJobOptions: {
              attempts: queue.attempts,
              backoff: { type: 'exponential', delay: queue.backoffDelayMs },
              removeOnComplete: true,
            },
          }),
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    await module.init();
    service = module.get(VideosService);
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
    await queue.obliterate({ force: true });
  });

  async function createUserWithChannel(): Promise<{ userId: string }> {
    const user = await dataSource.getRepository(User).save({
      email: `draft_user_${++counter}@example.com`,
      password: 'hashed',
    });
    await dataSource.getRepository(Channel).save({
      name: `draft_channel_${counter}`,
      nickname: `draft_channel_${counter}`,
      user_id: user.id,
    });
    return { userId: user.id };
  }

  it('should persist the draft and open a real multipart upload', async () => {
    const { userId } = await createUserWithChannel();

    const { video, partCount } = await service.createDraft(userId, {
      title: 'Integration video',
      filename: 'integration.mp4',
      size_bytes: 120 * 1024 * 1024,
      mime_type: 'video/mp4',
    });

    const persisted = await videoRepository.findOneByOrFail({ id: video.id });
    expect(persisted.status).toBe(VideoStatus.DRAFT);
    expect(persisted.processing_status).toBe(VideoProcessingStatus.UPLOADING);
    expect(persisted.public_id).toHaveLength(11);
    expect(persisted.upload_id).toBeTruthy();
    expect(persisted.size_bytes).toBe(String(120 * 1024 * 1024));
    expect(partCount).toBe(2);

    // The upload really exists in the storage — aborting it succeeds.
    await expect(
      storage.abortMultipartUpload(persisted.storage_key, persisted.upload_id!),
    ).resolves.toBeUndefined();
  });

  it('should assign distinct public ids to concurrent drafts', async () => {
    const { userId } = await createUserWithChannel();
    const dto = {
      title: 'Concurrent',
      filename: 'c.mp4',
      size_bytes: 1024,
      mime_type: 'video/mp4',
    };

    const drafts = await Promise.all([
      service.createDraft(userId, dto),
      service.createDraft(userId, dto),
      service.createDraft(userId, dto),
    ]);

    const ids = new Set(drafts.map((draft) => draft.video.public_id));
    expect(ids.size).toBe(3);
  });

  describe('completeUpload', () => {
    const PART_SIZE = 5 * 1024 * 1024;

    /** Creates a draft and uploads one real part to the storage. */
    async function uploadSinglePart(
      userId: string,
      body: Buffer,
    ): Promise<{ publicId: string; etag: string }> {
      const { video } = await service.createDraft(userId, {
        title: 'Complete me',
        filename: 'complete.mp4',
        size_bytes: body.length,
        mime_type: 'video/mp4',
      });

      const [part] = await service.signUploadParts(
        userId,
        video.public_id,
        [1],
      );
      const upload = await fetchSignedUrl(part.url, {
        method: 'PUT',
        body,
      });
      expect(upload.status).toBe(200);

      return { publicId: video.public_id, etag: upload.headers.get('etag')! };
    }

    it('should assemble the object, flip to processing and enqueue the job', async () => {
      const { userId } = await createUserWithChannel();
      const body = Buffer.alloc(PART_SIZE, 'a');
      const { publicId, etag } = await uploadSinglePart(userId, body);

      const video = await service.completeUpload(userId, publicId, [
        { partNumber: 1, etag },
      ]);

      expect(video.processing_status).toBe(VideoProcessingStatus.PROCESSING);
      expect(video.upload_id).toBeNull();

      const persisted = await videoRepository.findOneByOrFail({ id: video.id });
      expect(persisted.processing_status).toBe(
        VideoProcessingStatus.PROCESSING,
      );

      const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].data).toEqual({ videoId: video.id });

      // The assembled object really is in the storage with the full size.
      const head = await storage.headObject(persisted.storage_key);
      expect(head.contentLength).toBe(body.length);
    });

    it('should keep a single job when complete is called twice', async () => {
      const { userId } = await createUserWithChannel();
      const body = Buffer.alloc(PART_SIZE, 'b');
      const { publicId, etag } = await uploadSinglePart(userId, body);

      await service.completeUpload(userId, publicId, [{ partNumber: 1, etag }]);
      await service.completeUpload(userId, publicId, [{ partNumber: 1, etag }]);

      const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
      expect(jobs).toHaveLength(1);
    });
  });

  describe('abortUpload', () => {
    it('should remove the draft and invalidate the multipart upload', async () => {
      const { userId } = await createUserWithChannel();
      const { video } = await service.createDraft(userId, {
        title: 'Abort me',
        filename: 'abort.mp4',
        size_bytes: 1024,
        mime_type: 'video/mp4',
      });

      await service.abortUpload(userId, video.public_id);

      await expect(videoRepository.countBy({ id: video.id })).resolves.toBe(0);
      const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
      expect(jobs).toHaveLength(0);
    });
  });
});
