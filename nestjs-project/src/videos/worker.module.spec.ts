import { Test } from '@nestjs/testing';
import { StorageService } from '../storage/storage.service';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessor } from './video.processor';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile the worker context with the processor and ffmpeg wired', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    })
      // onModuleInit would bootstrap the bucket; wiring is what this covers.
      .overrideProvider(StorageService)
      .useValue({ onModuleInit: jest.fn() })
      .compile();

    expect(module.get(VideoProcessor)).toBeInstanceOf(VideoProcessor);
    expect(module.get(FfmpegService)).toBeInstanceOf(FfmpegService);

    await module.close();
  });
});
