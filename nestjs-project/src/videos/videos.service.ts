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
  UploadSizeMismatchException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { originalKey } from '../storage/storage.constants';
import {
  CompletedPart,
  PresignedPart,
  StorageService,
} from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import {
  Video,
  VideoProcessingStatus,
  VideoStatus,
} from './entities/video.entity';
import { persistWithUniquePublicId } from './public-id.util';
import { VideoProcessingProducer } from './video-processing.producer';

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
    private readonly producer: VideoProcessingProducer,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  /**
   * Pre-registers the video as a draft and opens the multipart upload
   * (phase-03-videos/TD-02, phase-03-videos/TD-08). No video bytes touch the
   * API — the client uploads each part straight to the storage.
   */
  async createDraft(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreatedDraft> {
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

  /**
   * Closes the multipart upload, verifies the assembled object and hands the
   * video over to the processing queue (phase-03-videos/TD-02,
   * phase-03-videos/TD-08).
   *
   * Idempotent by contract: calling it again on a video already in
   * `processing` just re-enqueues (the job id is the video id, so the queue
   * deduplicates), which is what makes a failed enqueue recoverable by a
   * client retry.
   */
  async completeUpload(
    userId: string,
    publicId: string,
    parts: CompletedPart[],
  ): Promise<Video> {
    const video = await this.findOwnedVideoOrFail(userId, publicId);

    if (video.processing_status === VideoProcessingStatus.PROCESSING) {
      await this.producer.enqueueProcessing(video.id);
      return video;
    }

    this.assertUploadInProgress(video);

    await this.storageService.completeMultipartUpload(
      video.storage_key,
      video.upload_id!,
      parts,
    );

    const { contentLength } = await this.storageService.headObject(
      video.storage_key,
    );
    if (
      video.size_bytes !== null &&
      contentLength !== Number(video.size_bytes)
    ) {
      throw new UploadSizeMismatchException();
    }

    video.processing_status = VideoProcessingStatus.PROCESSING;
    video.upload_id = null;
    const saved = await this.videoRepository.save(video);

    // Enqueue only after the state change is durable: a job picked up before
    // the commit would read a row still marked `uploading`.
    await this.producer.enqueueProcessing(saved.id);

    return saved;
  }

  /** Cancels an upload in progress and discards the draft (phase-03-videos/TD-02). */
  async abortUpload(userId: string, publicId: string): Promise<void> {
    const video = await this.findOwnedVideoOrFail(userId, publicId);
    this.assertUploadInProgress(video);

    await this.storageService.abortMultipartUpload(
      video.storage_key,
      video.upload_id!,
    );
    await this.videoRepository.delete({ id: video.id });
  }

  /**
   * Resolves a video for a viewer. The owner sees it in any state; everyone
   * else only once it is `ready` — and a draft is reported as not found rather
   * than forbidden, so the response does not confirm that the id exists
   * (phase-03-videos/TD-11).
   */
  async findForViewer(publicId: string, userId?: string): Promise<Video> {
    const video = await this.findByPublicIdOrFail(publicId);

    if (video.processing_status === VideoProcessingStatus.READY) {
      return video;
    }

    const channel = userId
      ? await this.channelsService.findByUserId(userId)
      : null;

    if (!channel || channel.id !== video.channel_id) {
      throw new VideoNotFoundException();
    }

    return video;
  }

  /** Short-lived signed URL for the thumbnail, when the worker already made one. */
  async buildThumbnailUrl(video: Video): Promise<string | null> {
    if (!video.thumbnail_key) return null;
    return this.storageService.presignGetObject(video.thumbnail_key);
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
