import { ApiProperty } from '@nestjs/swagger';
import {
  VideoMetadata,
  VideoProcessingStatus,
  VideoStatus,
} from '../entities/video.entity';

/**
 * Probe data the worker extracted from the file. Declared inline because
 * `VideoMetadata` is an interface and carries no schema of its own.
 */
export class VideoMetadataDto implements VideoMetadata {
  @ApiProperty({ type: Number, nullable: true, example: 1280 })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 720 })
  height: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'h264' })
  video_codec: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'aac' })
  audio_codec: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 1500000 })
  bitrate: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'mov,mp4,m4a,3gp,3g2,mj2',
  })
  format: string | null;
}

/** Shape returned by `GET /videos/:publicId` (clarificação AMB-2). */
export class VideoResponseDto {
  @ApiProperty({
    description: 'Public, unguessable id used by every video route',
    example: 'dQw4w9WgXcQ',
  })
  id: string;

  @ApiProperty({ example: 'My first video' })
  title: string;

  @ApiProperty({
    description: 'Editorial state. Only `draft` exists in this phase.',
    enum: VideoStatus,
  })
  status: string;

  @ApiProperty({
    description: 'Where the file is in the upload and processing pipeline',
    enum: VideoProcessingStatus,
  })
  processing_status: string;

  @ApiProperty({
    description:
      'Why processing failed. Only the owner ever sees a video in `failed`.',
    type: String,
    nullable: true,
  })
  processing_error: string | null;

  @ApiProperty({
    description: 'Duration in seconds, filled by the worker',
    type: Number,
    nullable: true,
    example: 42,
  })
  duration_seconds: number | null;

  @ApiProperty({ type: VideoMetadataDto, nullable: true })
  metadata: VideoMetadata | null;

  @ApiProperty({
    description:
      'Short-lived signed URL, null until the worker extracts a frame',
    type: String,
    nullable: true,
  })
  thumbnail_url: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at: string;
}
