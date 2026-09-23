import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  Max,
  Min,
} from 'class-validator';

/**
 * Body of `POST /videos/:publicId/upload/parts`.
 *
 * Part numbers run from 1 to 10000 (the S3 multipart ceiling); at most 1000
 * URLs are signed per call (phase-03-videos/TD-02).
 */
export class SignUploadPartsDto {
  @ApiProperty({
    description:
      'Part numbers to sign. Calling again re-signs parts whose URL expired.',
    type: [Number],
    minItems: 1,
    maxItems: 1000,
    example: [1, 2, 3],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(10000, { each: true })
  part_numbers: number[];
}
