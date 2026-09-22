import { IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

/**
 * Body of `POST /videos` — the client declares the file it is about to upload.
 * `title` is required from the start (clarificação AMB-1); phase 04 edits it.
 *
 * Size and MIME limits are NOT enforced here: the API contract maps them to
 * 413 / 415 domain errors, while schema failures are 400.
 */
export class CreateVideoDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename: string;

  @IsInt()
  @Min(1)
  size_bytes: number;

  @IsString()
  @MaxLength(127)
  mime_type: string;
}
