import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsService } from '../channels/channels.service';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  ALL_ENTITIES,
  createTestDataSource,
} from '../test/create-test-data-source';
import { VideosModule } from './videos.module';
import { VideoProcessingProducer } from './video-processing.producer';
import { VideosService } from './videos.service';

describe('VideosModule', () => {
  it('should compile with the Video repository, queue, ChannelsService and StorageService', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (queue: ReturnType<typeof queueConfig>) => ({
            connection: { host: queue.host, port: queue.port },
          }),
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    })
      // onModuleInit would reach the storage; module wiring is what this covers.
      .overrideProvider(StorageService)
      .useValue({ onModuleInit: jest.fn() })
      .compile();

    expect(module.get(VideosService)).toBeInstanceOf(VideosService);
    expect(module.get(ChannelsService)).toBeInstanceOf(ChannelsService);
    expect(module.get(VideoProcessingProducer)).toBeInstanceOf(
      VideoProcessingProducer,
    );

    await module.close();
  });
});
