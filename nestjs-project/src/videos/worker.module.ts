import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig from '../config/database.config';
import { envValidationSchema } from '../config/env.validation';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { Channel } from '../channels/entities/channel.entity';
import { StorageModule } from '../storage/storage.module';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { VIDEO_PROCESSING } from './video-processing.constants';
import { VideoProcessor } from './video.processor';

/**
 * Root module of the `video-worker` process (phase-03-videos/TD-06).
 *
 * Same codebase as the API, but no HTTP layer and no controllers: it only
 * wires what the processor needs — database, storage and the queue consumer.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, queueConfig, storageConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (db: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres' as const,
        host: db.host,
        port: db.port,
        username: db.username,
        password: db.password,
        database: db.name,
        // Explicit list instead of autoLoadEntities: the worker only registers
        // Video via forFeature, but Video -> Channel -> User must all resolve
        // or TypeORM cannot build the relation metadata and the process dies
        // on boot.
        entities: [Video, Channel, User],
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([Video]),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (queue: ConfigType<typeof queueConfig>) => ({
        prefix: queue.prefix,
        connection: {
          host: queue.host,
          port: queue.port,
          maxRetriesPerRequest: null,
        },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_PROCESSING.QUEUE }),
    StorageModule,
  ],
  providers: [VideoProcessor, FfmpegService],
})
export class WorkerModule {}
