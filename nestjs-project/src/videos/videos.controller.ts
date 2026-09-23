import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { SignUploadPartsDto } from './dto/sign-upload-parts.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideosService } from './videos.service';

/** Every error response in the project shares one envelope. */
const errorResponse = (status: number, description: string) => ({
  status,
  description,
  schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
});

const PUBLIC_ID_PARAM = {
  name: 'publicId',
  description: 'Public id returned when the draft was created',
  example: 'dQw4w9WgXcQ',
};

/** Headers every delivery redirect carries (phase-03-videos/TD-10). */
const DELIVERY_HEADERS = {
  Location: {
    description: 'Short-lived presigned URL on the object storage',
    schema: { type: 'string', format: 'uri' },
  },
  'Cache-Control': {
    description: 'Always `no-store`: the signed URL expires',
    schema: { type: 'string' },
  },
};

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft and opens a multipart upload. No video bytes go through the API: the client uploads each part straight to the object storage.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload opened',
    schema: {
      properties: {
        id: { type: 'string', example: 'dQw4w9WgXcQ' },
        title: { type: 'string' },
        status: { type: 'string', example: 'draft' },
        processing_status: { type: 'string', example: 'uploading' },
        upload: {
          type: 'object',
          properties: {
            upload_id: { type: 'string' },
            part_size: { type: 'integer', example: 67108864 },
            part_count: { type: 'integer', example: 2 },
          },
        },
      },
    },
  })
  @ApiResponse(errorResponse(400, 'Validation failed'))
  @ApiResponse(errorResponse(401, 'Missing or invalid access token'))
  @ApiResponse(errorResponse(404, 'The user has no channel to publish to'))
  @ApiResponse(errorResponse(413, 'Declared size above the configured limit'))
  @ApiResponse(errorResponse(415, 'Declared MIME type is not a video'))
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<{
    id: string;
    title: string;
    status: string;
    processing_status: string;
    upload: { upload_id: string; part_size: number; part_count: number };
  }> {
    const { video, partSize, partCount } = await this.videosService.createDraft(
      user.sub,
      dto,
    );

    return {
      id: video.public_id,
      title: video.title,
      status: video.status,
      processing_status: video.processing_status,
      upload: {
        upload_id: video.upload_id!,
        part_size: partSize,
        part_count: partCount,
      },
    };
  }

  @Post(':publicId/upload/parts')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiOperation({
    summary: 'Sign upload URLs for parts',
    description:
      'Returns one presigned URL per requested part. Call it again to re-sign parts whose URL expired — that is how an interrupted upload resumes.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned URLs, one per requested part',
    schema: {
      properties: {
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              part_number: { type: 'integer', example: 1 },
              url: { type: 'string', format: 'uri' },
              expires_at: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
  })
  @ApiResponse(errorResponse(400, 'Validation failed'))
  @ApiResponse(errorResponse(401, 'Missing or invalid access token'))
  @ApiResponse(errorResponse(403, 'The video belongs to another channel'))
  @ApiResponse(errorResponse(404, 'Unknown public id'))
  @ApiResponse(errorResponse(409, 'The upload is no longer in progress'))
  async signUploadParts(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: SignUploadPartsDto,
  ): Promise<{
    parts: { part_number: number; url: string; expires_at: string }[];
  }> {
    const parts = await this.videosService.signUploadParts(
      user.sub,
      publicId,
      dto.part_numbers,
    );

    return {
      parts: parts.map((part) => ({
        part_number: part.partNumber,
        url: part.url,
        expires_at: part.expiresAt.toISOString(),
      })),
    };
  }

  @Post(':publicId/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiOperation({
    summary: 'Finish the upload and queue processing',
    description:
      'Assembles the parts, checks the resulting size against the declared one and hands the video to the processing queue. Idempotent: repeating the call on a video already processing just re-enqueues it.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload closed; the video moved to `processing`',
    schema: {
      properties: {
        id: { type: 'string', example: 'dQw4w9WgXcQ' },
        status: { type: 'string', example: 'draft' },
        processing_status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse(errorResponse(400, 'Validation failed'))
  @ApiResponse(errorResponse(401, 'Missing or invalid access token'))
  @ApiResponse(errorResponse(403, 'The video belongs to another channel'))
  @ApiResponse(errorResponse(404, 'Unknown public id'))
  @ApiResponse(errorResponse(409, 'The upload is no longer in progress'))
  @ApiResponse(
    errorResponse(422, 'Assembled size differs from the declared one'),
  )
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<{ id: string; status: string; processing_status: string }> {
    const video = await this.videosService.completeUpload(
      user.sub,
      publicId,
      dto.parts.map((part) => ({
        partNumber: part.part_number,
        etag: part.etag,
      })),
    );

    return {
      id: video.public_id,
      status: video.status,
      processing_status: video.processing_status,
    };
  }

  @Delete(':publicId/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiOperation({
    summary: 'Cancel an upload in progress',
    description:
      'Aborts the multipart upload, discarding the parts already sent, and deletes the draft.',
  })
  @ApiResponse({
    status: 204,
    description: 'Upload cancelled and draft removed',
  })
  @ApiResponse(errorResponse(401, 'Missing or invalid access token'))
  @ApiResponse(errorResponse(403, 'The video belongs to another channel'))
  @ApiResponse(errorResponse(404, 'Unknown public id'))
  @ApiResponse(errorResponse(409, 'The upload is no longer in progress'))
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<void> {
    await this.videosService.abortUpload(user.sub, publicId);
  }

  /**
   * Playback without a full download (phase-03-videos/TD-10): the API answers
   * `302` and the storage serves the byte ranges the player asks for.
   *
   * Together with the download route below, this is the documented exception
   * to the strict-BFF convention inherited from phase 02
   * (phase-03-videos/TD-10, phase-03-videos/TD-11): the browser reaches these
   * two public media routes directly — a `<video>` tag and a download link
   * cannot go through the BFF — while every authenticated call still does.
   */
  @Public()
  @Get(':publicId/stream')
  @Redirect()
  @Header('Cache-Control', 'no-store')
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiOperation({
    summary: 'Stream the video',
    description:
      'Redirects to a short-lived signed URL on the object storage, which answers `Range` requests with `206 Partial Content`. No video byte passes through the API, so playback never needs the whole file.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the object storage',
    headers: DELIVERY_HEADERS,
  })
  @ApiResponse(errorResponse(404, 'Unknown public id'))
  @ApiResponse(errorResponse(409, 'The video has not finished processing'))
  async stream(@Param('publicId') publicId: string): Promise<{ url: string }> {
    return {
      url: await this.videosService.buildDeliveryUrl(publicId, 'stream'),
    };
  }

  /** Same redirect, signed so the storage sends the file as an attachment. */
  @Public()
  @Get(':publicId/download')
  @Redirect()
  @Header('Cache-Control', 'no-store')
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiOperation({
    summary: 'Download the video',
    description:
      'Same redirect as the stream endpoint, signed with `Content-Disposition: attachment` so the browser saves the file under its original name.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the object storage, which serves the attachment',
    headers: DELIVERY_HEADERS,
  })
  @ApiResponse(errorResponse(404, 'Unknown public id'))
  @ApiResponse(errorResponse(409, 'The video has not finished processing'))
  async download(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string }> {
    return {
      url: await this.videosService.buildDeliveryUrl(publicId, 'download'),
    };
  }

  @Public()
  @Get(':publicId')
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiOperation({
    summary: 'Get a video',
    description:
      'Public route: anyone holding the id sees a video once it is `ready`. The owner also sees it while it is still uploading, processing or failed — to anyone else those states answer the same 404 as an unknown id, so the response never confirms that the id exists.',
  })
  @ApiResponse({ status: 200, type: VideoResponseDto })
  @ApiResponse(
    errorResponse(404, 'Unknown public id, or not visible to this viewer'),
  )
  async findOne(
    @CurrentUser() user: JwtPayload | undefined,
    @Param('publicId') publicId: string,
  ): Promise<VideoResponseDto> {
    const video = await this.videosService.findForViewer(publicId, user?.sub);

    return {
      id: video.public_id,
      title: video.title,
      status: video.status,
      processing_status: video.processing_status,
      processing_error: video.processing_error,
      duration_seconds: video.duration_seconds,
      metadata: video.metadata,
      thumbnail_url: await this.videosService.buildThumbnailUrl(video),
      created_at: video.created_at.toISOString(),
    };
  }
}
