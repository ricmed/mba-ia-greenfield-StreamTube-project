import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

/**
 * Body of `POST /videos` — the client declares the file it is about to upload.
 * `title` is required from the start (clarificação AMB-1); phase 04 edits it.
 *
 * Size and MIME limits are NOT enforced here: the API contract maps them to
 * 413 / 415 domain errors, while schema failures are 400.
 */
export class CreateVideoDto {
  @ApiProperty({
    description: 'Title shown to viewers',
    minLength: 1,
    maxLength: 255,
    example: 'My first video',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title: string;

  @ApiProperty({
    description: 'Original file name, reused as the download file name',
    minLength: 1,
    maxLength: 255,
    example: 'my-first-video.mp4',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename: string;

  @ApiProperty({
    description:
      'Declared size of the file in bytes. Above the configured limit the request is rejected with 413.',
    minimum: 1,
    example: 125829120,
  })
  @IsInt()
  @Min(1)
  size_bytes: number;

  @ApiProperty({
    description: 'Declared MIME type. Anything outside `video/*` yields 415.',
    maxLength: 127,
    example: 'video/mp4',
  })
  @IsString()
  @MaxLength(127)
  mime_type: string;
}
