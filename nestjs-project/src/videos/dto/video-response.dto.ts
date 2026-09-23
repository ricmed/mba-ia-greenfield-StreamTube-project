import { VideoMetadata } from '../entities/video.entity';

/** Shape returned by `GET /videos/:publicId` (clarificação AMB-2). */
export class VideoResponseDto {
  id: string;
  title: string;
  status: string;
  processing_status: string;
  processing_error: string | null;
  duration_seconds: number | null;
  metadata: VideoMetadata | null;
  thumbnail_url: string | null;
  created_at: string;
}
