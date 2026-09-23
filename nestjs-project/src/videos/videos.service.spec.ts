import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  FileTooLargeException,
  NotVideoOwnerException,
  UnsupportedMediaTypeException,
  UploadNotInProgressException,
  UploadSizeMismatchException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import { VideoProcessingProducer } from './video-processing.producer';
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
  let repository: {
    create: jest.Mock;
    save: jest.Mock;
    findOneBy: jest.Mock;
    delete: jest.Mock;
  };
  let channels: { findByUserId: jest.Mock };
  let storage: {
    createMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
    presignUploadParts: jest.Mock;
    presignGetObject: jest.Mock;
    completeMultipartUpload: jest.Mock;
    headObject: jest.Mock;
  };
  let producer: { enqueueProcessing: jest.Mock };

  beforeEach(async () => {
    repository = {
      create: jest.fn((entity) => entity),
      save: jest.fn((entity) => Promise.resolve(entity)),
      findOneBy: jest.fn(),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    channels = {
      findByUserId: jest.fn().mockResolvedValue({ id: 'channel-1' }),
    };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      presignUploadParts: jest.fn().mockResolvedValue([]),
      presignGetObject: jest.fn().mockResolvedValue('https://signed/thumb'),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn(),
    };
    producer = { enqueueProcessing: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: ChannelsService, useValue: channels },
        { provide: StorageService, useValue: storage },
        { provide: VideoProcessingProducer, useValue: producer },
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

  describe('completeUpload', () => {
    const uploadingVideo = () =>
      ({
        id: 'video-1',
        public_id: 'abcdefghijk',
        channel_id: 'channel-1',
        storage_key: 'videos/video-1/original',
        upload_id: 'upload-1',
        size_bytes: '1024',
        processing_status: VideoProcessingStatus.UPLOADING,
      }) as Video;

    const parts = [{ partNumber: 1, etag: 'etag-1' }];

    it('should complete the upload, flip to processing and enqueue the job', async () => {
      repository.findOneBy.mockResolvedValue(uploadingVideo());
      storage.headObject.mockResolvedValue({ contentLength: 1024 });

      const video = await service.completeUpload(
        'user-1',
        'abcdefghijk',
        parts,
      );

      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original',
        'upload-1',
        parts,
      );
      expect(video.processing_status).toBe(VideoProcessingStatus.PROCESSING);
      expect(video.upload_id).toBeNull();
      expect(producer.enqueueProcessing).toHaveBeenCalledWith('video-1');
    });

    it('should enqueue only after the state change was saved', async () => {
      repository.findOneBy.mockResolvedValue(uploadingVideo());
      storage.headObject.mockResolvedValue({ contentLength: 1024 });
      const order: string[] = [];
      repository.save.mockImplementation((entity) => {
        order.push('save');
        return Promise.resolve(entity);
      });
      producer.enqueueProcessing.mockImplementation(() => {
        order.push('enqueue');
        return Promise.resolve();
      });

      await service.completeUpload('user-1', 'abcdefghijk', parts);

      expect(order).toEqual(['save', 'enqueue']);
    });

    it('should reject when the assembled object size differs from the declared one', async () => {
      repository.findOneBy.mockResolvedValue(uploadingVideo());
      storage.headObject.mockResolvedValue({ contentLength: 999 });

      await expect(
        service.completeUpload('user-1', 'abcdefghijk', parts),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);

      expect(producer.enqueueProcessing).not.toHaveBeenCalled();
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('should be idempotent: a second call on a processing video only re-enqueues', async () => {
      repository.findOneBy.mockResolvedValue({
        ...uploadingVideo(),
        processing_status: VideoProcessingStatus.PROCESSING,
        upload_id: null,
      });

      await service.completeUpload('user-1', 'abcdefghijk', parts);

      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(producer.enqueueProcessing).toHaveBeenCalledWith('video-1');
    });

    it('should reject completing a video that is already ready', async () => {
      repository.findOneBy.mockResolvedValue({
        ...uploadingVideo(),
        processing_status: VideoProcessingStatus.READY,
        upload_id: null,
      });

      await expect(
        service.completeUpload('user-1', 'abcdefghijk', parts),
      ).rejects.toBeInstanceOf(UploadNotInProgressException);
    });
  });

  describe('abortUpload', () => {
    it('should abort the multipart upload and delete the draft', async () => {
      repository.findOneBy.mockResolvedValue({
        id: 'video-1',
        public_id: 'abcdefghijk',
        channel_id: 'channel-1',
        storage_key: 'videos/video-1/original',
        upload_id: 'upload-1',
        processing_status: VideoProcessingStatus.UPLOADING,
      } as Video);

      await service.abortUpload('user-1', 'abcdefghijk');

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original',
        'upload-1',
      );
      expect(repository.delete).toHaveBeenCalledWith({ id: 'video-1' });
    });

    it('should refuse to abort once processing started', async () => {
      repository.findOneBy.mockResolvedValue({
        id: 'video-1',
        channel_id: 'channel-1',
        processing_status: VideoProcessingStatus.PROCESSING,
        upload_id: null,
      } as Video);

      await expect(
        service.abortUpload('user-1', 'abcdefghijk'),
      ).rejects.toBeInstanceOf(UploadNotInProgressException);
      expect(repository.delete).not.toHaveBeenCalled();
    });
  });

  describe('findForViewer', () => {
    const readyVideo = {
      id: 'video-1',
      public_id: 'abcdefghijk',
      channel_id: 'channel-1',
      thumbnail_key: 'videos/video-1/thumbnail.jpg',
      processing_status: VideoProcessingStatus.READY,
    } as Video;

    const draftVideo = {
      ...readyVideo,
      thumbnail_key: null,
      processing_status: VideoProcessingStatus.PROCESSING,
    } as Video;

    it('should return a ready video to an anonymous viewer', async () => {
      repository.findOneBy.mockResolvedValue(readyVideo);

      await expect(service.findForViewer('abcdefghijk')).resolves.toBe(
        readyVideo,
      );
      expect(channels.findByUserId).not.toHaveBeenCalled();
    });

    it('should return a video still processing to its owner', async () => {
      repository.findOneBy.mockResolvedValue(draftVideo);

      await expect(
        service.findForViewer('abcdefghijk', 'user-1'),
      ).resolves.toBe(draftVideo);
    });

    it('should hide a video still processing from an anonymous viewer', async () => {
      repository.findOneBy.mockResolvedValue(draftVideo);

      await expect(service.findForViewer('abcdefghijk')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });

    it('should hide a video still processing from another channel', async () => {
      repository.findOneBy.mockResolvedValue(draftVideo);
      channels.findByUserId.mockResolvedValue({ id: 'another-channel' });

      await expect(
        service.findForViewer('abcdefghijk', 'user-2'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('buildThumbnailUrl', () => {
    it('should sign the thumbnail when the worker produced one', async () => {
      const url = await service.buildThumbnailUrl({
        thumbnail_key: 'videos/video-1/thumbnail.jpg',
      } as Video);

      expect(url).toBe('https://signed/thumb');
      expect(storage.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/thumbnail.jpg',
      );
    });

    it('should return null while there is no thumbnail yet', async () => {
      await expect(
        service.buildThumbnailUrl({ thumbnail_key: null } as Video),
      ).resolves.toBeNull();
      expect(storage.presignGetObject).not.toHaveBeenCalled();
    });
  });
});
