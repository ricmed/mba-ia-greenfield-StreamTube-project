import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { SignUploadPartsDto } from './dto/sign-upload-parts.dto';
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
}
