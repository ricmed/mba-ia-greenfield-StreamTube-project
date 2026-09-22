import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  FileTooLargeException,
  NotVideoOwnerException,
  UnsupportedMediaTypeException,
  UploadNotInProgressException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoProcessingStatus } from './entities/video.entity';
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

describe('VideosService', () => {
  let service: VideosService;
  let repository: { create: jest.Mock; save: jest.Mock; findOneBy: jest.Mock };
  let channels: { findByUserId: jest.Mock };
  let storage: {
    createMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
    presignUploadParts: jest.Mock;
  };

  beforeEach(async () => {
    repository = {
      create: jest.fn((entity) => entity),
      save: jest.fn((entity) => Promise.resolve(entity)),
      findOneBy: jest.fn(),
    };
    channels = {
      findByUserId: jest.fn().mockResolvedValue({ id: 'channel-1' }),
    };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      presignUploadParts: jest.fn().mockResolvedValue([]),
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

  describe('createDraft', () => {
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
        service.createDraft(
          'user-1',
          validDto({ mime_type: 'application/pdf' }),
        ),
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

  describe('signUploadParts', () => {
    const uploadingVideo = {
      id: 'video-1',
      public_id: 'abcdefghijk',
      channel_id: 'channel-1',
      storage_key: 'videos/video-1/original',
      upload_id: 'upload-1',
      processing_status: VideoProcessingStatus.UPLOADING,
    } as Video;

    it('should sign the requested parts for the owner', async () => {
      repository.findOneBy.mockResolvedValue(uploadingVideo);
      storage.presignUploadParts.mockResolvedValue([
        { partNumber: 1, url: 'https://signed/1', expiresAt: new Date() },
      ]);

      const parts = await service.signUploadParts('user-1', 'abcdefghijk', [1]);

      expect(parts).toHaveLength(1);
      expect(storage.presignUploadParts).toHaveBeenCalledWith(
        'videos/video-1/original',
        'upload-1',
        [1],
      );
    });

    it('should reject a caller whose channel does not own the video', async () => {
      repository.findOneBy.mockResolvedValue(uploadingVideo);
      channels.findByUserId.mockResolvedValue({ id: 'another-channel' });

      await expect(
        service.signUploadParts('user-2', 'abcdefghijk', [1]),
      ).rejects.toBeInstanceOf(NotVideoOwnerException);
    });

    it('should fail when the video does not exist', async () => {
      repository.findOneBy.mockResolvedValue(null);

      await expect(
        service.signUploadParts('user-1', 'missingxxxx', [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should fail when the upload is no longer in progress', async () => {
      repository.findOneBy.mockResolvedValue({
        ...uploadingVideo,
        processing_status: VideoProcessingStatus.PROCESSING,
      });

      await expect(
        service.signUploadParts('user-1', 'abcdefghijk', [1]),
      ).rejects.toBeInstanceOf(UploadNotInProgressException);
    });

    it('should fail when the upload id was already cleared', async () => {
      repository.findOneBy.mockResolvedValue({
        ...uploadingVideo,
        upload_id: null,
      });

      await expect(
        service.signUploadParts('user-1', 'abcdefghijk', [1]),
      ).rejects.toBeInstanceOf(UploadNotInProgressException);
    });
  });
});
