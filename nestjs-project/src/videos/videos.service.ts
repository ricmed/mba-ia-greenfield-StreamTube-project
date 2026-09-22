import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import storageConfig from '../config/storage.config';
import {
  FileTooLargeException,
  NotVideoOwnerException,
  UnsupportedMediaTypeException,
  UploadNotInProgressException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { originalKey } from '../storage/storage.constants';
import { PresignedPart, StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoProcessingStatus, VideoStatus } from './entities/video.entity';
import { persistWithUniquePublicId } from './public-id.util';

export interface CreatedDraft {
  video: Video;
  partSize: number;
  partCount: number;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  /**
   * Pre-registers the video as a draft and opens the multipart upload
   * (phase-03-videos/TD-02, phase-03-videos/TD-08). No video bytes touch the
   * API — the client uploads each part straight to the storage.
   */
  async createDraft(userId: string, dto: CreateVideoDto): Promise<CreatedDraft> {
    if (dto.size_bytes > this.storage.maxUploadSizeBytes) {
      throw new FileTooLargeException();
    }
    if (!dto.mime_type.startsWith('video/')) {
      throw new UnsupportedMediaTypeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) throw new VideoNotFoundException();

    const id = randomUUID();
    const storage_key = originalKey(id);
    const uploadId = await this.storageService.createMultipartUpload(
      storage_key,
      dto.mime_type,
    );

    try {
      const video = await persistWithUniquePublicId((public_id) =>
        this.videoRepository.save(
          this.videoRepository.create({
            id,
            public_id,
            channel_id: channel.id,
            title: dto.title,
            status: VideoStatus.DRAFT,
            processing_status: VideoProcessingStatus.UPLOADING,
            storage_key,
            upload_id: uploadId,
            original_filename: dto.filename,
            mime_type: dto.mime_type,
            size_bytes: String(dto.size_bytes),
          }),
        ),
      );

      return {
        video,
        partSize: this.storage.partSizeBytes,
        partCount: Math.ceil(dto.size_bytes / this.storage.partSizeBytes),
      };
    } catch (err) {
      // The multipart upload is already open; leaving it behind would keep
      // orphan parts in the storage forever.
      await this.storageService.abortMultipartUpload(storage_key, uploadId);
      throw err;
    }
  }

  /**
   * Signs one upload URL per requested part (phase-03-videos/TD-02). Also the
   * resume path: expired URLs are re-signed by calling this again.
   */
  async signUploadParts(
    userId: string,
    publicId: string,
    partNumbers: number[],
  ): Promise<PresignedPart[]> {
    const video = await this.findOwnedVideoOrFail(userId, publicId);
    this.assertUploadInProgress(video);

    return this.storageService.presignUploadParts(
      video.storage_key,
      video.upload_id!,
      partNumbers,
    );
  }

  async findByPublicIdOrFail(publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOneBy({ public_id: publicId });
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  /** Resolves the video and asserts the caller's channel owns it. */
  private async findOwnedVideoOrFail(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.findByPublicIdOrFail(publicId);
    const channel = await this.channelsService.findByUserId(userId);

    if (!channel || channel.id !== video.channel_id) {
      throw new NotVideoOwnerException();
    }

    return video;
  }

  private assertUploadInProgress(video: Video): void {
    if (
      video.processing_status !== VideoProcessingStatus.UPLOADING ||
      !video.upload_id
    ) {
      throw new UploadNotInProgressException();
    }
  }
}
