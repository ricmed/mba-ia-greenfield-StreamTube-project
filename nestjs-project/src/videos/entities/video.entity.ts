import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

/**
 * Editorial state. Phase 03 only ever produces `draft`; phase 04 adds the
 * publication flow on top of this same column (phase-03-videos/TD-08).
 */
export enum VideoStatus {
  DRAFT = 'draft',
}

/**
 * Technical state of the upload + processing pipeline, orthogonal to the
 * editorial one (phase-03-videos/TD-08).
 */
export enum VideoProcessingStatus {
  UPLOADING = 'uploading',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

export interface VideoMetadata {
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  bitrate: number | null;
  format: string | null;
}

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Short unguessable id used by every public route (phase-03-videos/TD-09). */
  @Column({ type: 'varchar', length: 11, unique: true })
  public_id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'enum', enum: VideoStatus, default: VideoStatus.DRAFT })
  status: VideoStatus;

  @Index()
  @Column({
    type: 'enum',
    enum: VideoProcessingStatus,
    default: VideoProcessingStatus.UPLOADING,
  })
  processing_status: VideoProcessingStatus;

  @Column({ type: 'text', nullable: true })
  processing_error: string | null;

  @Column({ type: 'varchar', length: 512 })
  storage_key: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnail_key: string | null;

  /** Multipart UploadId; cleared once the upload completes or is aborted. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 127 })
  mime_type: string;

  @Column({ type: 'bigint', nullable: true })
  size_bytes: string | null;

  @Column({ type: 'integer', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: VideoMetadata | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
