import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VIDEO_PROCESSING } from './video-processing.constants';
import { VideoProcessingProducer } from './video-processing.producer';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    BullModule.registerQueue({ name: VIDEO_PROCESSING.QUEUE }),
    ChannelsModule,
    StorageModule,
  ],
  controllers: [VideosController],
  providers: [VideosService, VideoProcessingProducer],
  exports: [TypeOrmModule, VideosService, VideoProcessingProducer],
})
export class VideosModule {}
