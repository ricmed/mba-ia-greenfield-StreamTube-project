import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class UploadedPartDto {
  @IsInt()
  @Min(1)
  @Max(10000)
  part_number: number;

  /** ETag returned by the storage for that part (phase-03-videos/TD-02). */
  @IsString()
  @MinLength(1)
  etag: string;
}

export class CompleteUploadDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10000)
  @ValidateNested({ each: true })
  @Type(() => UploadedPartDto)
  parts: UploadedPartDto[];
}
