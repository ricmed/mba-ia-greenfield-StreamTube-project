import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CreateVideoDto } from './dto/create-video.dto';
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
}
