import { ApiProperty } from '@nestjs/swagger';
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
  @ApiProperty({ minimum: 1, maximum: 10000, example: 1 })
  @IsInt()
  @Min(1)
  @Max(10000)
  part_number: number;

  /** ETag returned by the storage for that part (phase-03-videos/TD-02). */
  @ApiProperty({
    description: 'ETag the storage returned when the part was uploaded',
    example: '"9bb58f26192e4ba00f01e2e7b136bbd8"',
  })
  @IsString()
  @MinLength(1)
  etag: string;
}

export class CompleteUploadDto {
  @ApiProperty({
    description: 'Every uploaded part, in any order',
    type: [UploadedPartDto],
    minItems: 1,
    maxItems: 10000,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10000)
  @ValidateNested({ each: true })
  @Type(() => UploadedPartDto)
  parts: UploadedPartDto[];
}
