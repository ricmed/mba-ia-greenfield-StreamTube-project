import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  FileTooLargeException,
  UnsupportedMediaTypeException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';

const MAX_SIZE = 10_737_418_240;
const PART_SIZE = 67_108_864;

const validDto = (overrides: Partial<CreateVideoDto> = {}): CreateVideoDto => ({
  title: 'My video',
  filename: 'my-video.mp4',
  size_bytes: PART_SIZE * 2,
  mime_type: 'video/mp4',
  ...overrides,
});

describe('VideosService.createDraft', () => {
  let service: VideosService;
  let repository: { create: jest.Mock; save: jest.Mock; findOneBy: jest.Mock };
  let channels: { findByUserId: jest.Mock };
  let storage: {
    createMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
  };

  beforeEach(async () => {
    repository = {
      create: jest.fn((entity) => entity),
      save: jest.fn((entity) => Promise.resolve(entity)),
      findOneBy: jest.fn(),
    };
    channels = { findByUserId: jest.fn().mockResolvedValue({ id: 'channel-1' }) };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: ChannelsService, useValue: channels },
        { provide: StorageService, useValue: storage },
        {
          provide: storageConfig.KEY,
          useValue: {
            maxUploadSizeBytes: MAX_SIZE,
            partSizeBytes: PART_SIZE,
            urlExpirationSeconds: 3600,
          },
        },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  it('should create the draft with a rounded-up part count', async () => {
    const { video, partSize, partCount } = await service.createDraft(
      'user-1',
      validDto({ size_bytes: PART_SIZE + 1 }),
    );

    expect(partSize).toBe(PART_SIZE);
    expect(partCount).toBe(2);
    expect(video.status).toBe('draft');
    expect(video.processing_status).toBe('uploading');
    expect(video.upload_id).toBe('upload-1');
    expect(video.channel_id).toBe('channel-1');
    expect(video.storage_key).toBe(`videos/${video.id}/original`);
  });

  it('should reject a file above the configured maximum', async () => {
    await expect(
      service.createDraft('user-1', validDto({ size_bytes: MAX_SIZE + 1 })),
    ).rejects.toBeInstanceOf(FileTooLargeException);

    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('should reject a non-video mime type', async () => {
    await expect(
      service.createDraft('user-1', validDto({ mime_type: 'application/pdf' })),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);

    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('should fail when the user has no channel', async () => {
    channels.findByUserId.mockResolvedValue(null);

    await expect(
      service.createDraft('user-1', validDto()),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  });

  it('should abort the multipart upload when persistence fails', async () => {
    repository.save.mockRejectedValue(new Error('db down'));

    await expect(service.createDraft('user-1', validDto())).rejects.toThrow(
      'db down',
    );

    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
      expect.stringMatching(/^videos\/.+\/original$/),
      'upload-1',
    );
  });
});
