import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoProcessingStatus, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );

    return channelRepository.save(
      channelRepository.create({
        name: `channel_${counter}`,
        nickname: `channel_${counter}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channel: Channel, overrides: Partial<Video> = {}): Video {
    return videoRepository.create({
      public_id: `pub${(++counter).toString().padStart(8, '0')}`,
      channel_id: channel.id,
      title: 'My video',
      storage_key: 'videos/x/original',
      original_filename: 'my-video.mp4',
      mime_type: 'video/mp4',
      ...overrides,
    });
  }

  it('should default status to draft and processing_status to uploading', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(buildVideo(channel));
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.processing_status).toBe(VideoProcessingStatus.UPLOADING);
    expect(found.thumbnail_key).toBeNull();
    expect(found.duration_seconds).toBeNull();
    expect(found.metadata).toBeNull();
    expect(found.created_at).toBeInstanceOf(Date);
  });

  it('should reject a duplicate public_id', async () => {
    const channel = await createChannel();
    const first = await videoRepository.save(buildVideo(channel));

    await expect(
      videoRepository.save(
        buildVideo(channel, { public_id: first.public_id }),
      ),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('should reject a video without a title', async () => {
    const channel = await createChannel();
    const video = buildVideo(channel);
    // @ts-expect-error — exercising the NOT NULL constraint at the DB level
    video.title = null;

    await expect(videoRepository.save(video)).rejects.toBeInstanceOf(
      QueryFailedError,
    );
  });

  it('should persist metadata as jsonb and size_bytes as a bigint', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      buildVideo(channel, {
        size_bytes: '10737418240',
        duration_seconds: 42,
        metadata: {
          width: 1280,
          height: 720,
          video_codec: 'h264',
          audio_codec: 'aac',
          bitrate: 900_000,
          format: 'mov,mp4,m4a,3gp,3g2,mj2',
        },
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.size_bytes).toBe('10737418240');
    expect(found.metadata?.width).toBe(1280);
    expect(found.metadata?.video_codec).toBe('h264');
  });

  it('should cascade delete videos when the owning channel is removed', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel));

    await channelRepository.delete({ id: channel.id });

    await expect(
      videoRepository.countBy({ channel_id: channel.id }),
    ).resolves.toBe(0);
  });
});
