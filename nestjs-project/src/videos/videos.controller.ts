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
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { SignUploadPartsDto } from './dto/sign-upload-parts.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@ApiBearerAuth()
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
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
  async download(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string }> {
    return {
      url: await this.videosService.buildDeliveryUrl(publicId, 'download'),
    };
  }

  @Public()
  @Get(':publicId')
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
