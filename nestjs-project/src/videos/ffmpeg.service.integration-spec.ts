import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  createCorruptFixture,
  createVideoFixture,
} from '../test/video-fixture';
import { FfmpegService, InvalidVideoFileError } from './ffmpeg.service';

describe('FfmpegService (integration)', () => {
  let module: TestingModule;
  let ffmpeg: FfmpegService;
  let storage: StorageService;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [FfmpegService],
    }).compile();

    await module.init();
    ffmpeg = module.get(FfmpegService);
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    await module.close();
  });

  /** Uploads the bytes and returns an internal presigned URL for them. */
  async function publish(body: Buffer): Promise<string> {
    const key = `test/${randomUUID()}/original`;
    await storage.putObject(key, body, 'video/mp4');
    return storage.presignInternalGetObject(key);
  }

  it('should read duration and metadata straight from a presigned url', async () => {
    const url = await publish(await createVideoFixture({ durationSeconds: 2 }));

    const { durationSeconds, metadata } = await ffmpeg.probe(url);

    expect(durationSeconds).toBe(2);
    expect(metadata.width).toBe(320);
    expect(metadata.height).toBe(240);
    expect(metadata.video_codec).toBe('h264');
    expect(metadata.audio_codec).toBe('aac');
    expect(metadata.format).toContain('mp4');
    expect(metadata.bitrate).toBeGreaterThan(0);
  });

  it('should extract a JPEG frame from the video', async () => {
    const url = await publish(await createVideoFixture({ durationSeconds: 3 }));

    const thumbnail = await ffmpeg.extractThumbnail(url, 3);

    expect(thumbnail.length).toBeGreaterThan(0);
    // JPEG magic number.
    expect(thumbnail.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it('should cap the thumbnail width at 1280px', async () => {
    const url = await publish(
      await createVideoFixture({ width: 1920, height: 1080 }),
    );

    const thumbnail = await ffmpeg.extractThumbnail(url, 2);
    const probeUrl = await publish(thumbnail);
    const { metadata } = await ffmpeg.probe(probeUrl);

    expect(metadata.width).toBe(1280);
    expect(metadata.height).toBe(720);
  });

  it('should reject a file that is not a video', async () => {
    const url = await publish(createCorruptFixture());

    await expect(ffmpeg.probe(url)).rejects.toBeInstanceOf(
      InvalidVideoFileError,
    );
  });
});
