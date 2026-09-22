import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import appConfig from '../config/app.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoProcessingStatus, VideoStatus } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService — createDraft (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let counter = 0;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [appConfig, storageConfig],
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
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
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
});
