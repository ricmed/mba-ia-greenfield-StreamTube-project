import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import storageConfig from '../config/storage.config';
import { fetchSignedUrl } from '../test/signed-url';
import { StorageModule } from './storage.module';
import { CompletedPart, StorageService } from './storage.service';

// S3 requires every part but the last to be at least 5 MiB.
const PART_SIZE = 5 * 1024 * 1024;

describe('StorageService (integration)', () => {
  let module: TestingModule;
  let storage: StorageService;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    // Triggers onModuleInit → ensureBucket().
    await module.init();
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    await module.close();
  });

  it('should create the bucket idempotently', async () => {
    await expect(storage.ensureBucket()).resolves.toBeUndefined();
    await expect(storage.ensureBucket()).resolves.toBeUndefined();
  });

  it('should complete a multipart upload assembled from presigned part URLs', async () => {
    const key = `test/${randomUUID()}/original`;
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    const [firstPart, secondPart] = await storage.presignUploadParts(
      key,
      uploadId,
      [1, 2],
    );
    expect(firstPart.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const bodies = [Buffer.alloc(PART_SIZE, 'a'), Buffer.from('tail')];
    const uploaded: CompletedPart[] = [];

    for (const [index, part] of [firstPart, secondPart].entries()) {
      const response = await fetchSignedUrl(part.url, {
        method: 'PUT',
        body: bodies[index],
      });
      expect(response.status).toBe(200);

      const etag = response.headers.get('etag');
      expect(etag).toBeTruthy();
      uploaded.push({ partNumber: part.partNumber, etag: etag! });
    }

    await storage.completeMultipartUpload(key, uploadId, uploaded);

    const { contentLength } = await storage.headObject(key);
    expect(contentLength).toBe(PART_SIZE + bodies[1].length);
  });

  it('should abort a multipart upload so it can no longer be completed', async () => {
    const key = `test/${randomUUID()}/original`;
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    await storage.abortMultipartUpload(key, uploadId);

    await expect(storage.headObject(key)).rejects.toBeDefined();
  });

  it('should serve a byte range from a presigned GET url', async () => {
    const key = `test/${randomUUID()}/original`;
    await storage.putObject(key, Buffer.from('0123456789'), 'video/mp4');

    const url = await storage.presignGetObject(key);
    const response = await fetchSignedUrl(url, {
      headers: { Range: 'bytes=0-3' },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-3/10');
    expect(await response.text()).toBe('0123');
  });

  it('should sign a download url carrying the attachment disposition', async () => {
    const key = `test/${randomUUID()}/original`;
    await storage.putObject(key, Buffer.from('payload'), 'video/mp4');

    const url = await storage.presignGetObject(key, {
      downloadFilename: 'my video.mp4',
    });
    const response = await fetchSignedUrl(url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('content-disposition')).toContain('my video.mp4');
  });

  it('should sign an internal url usable from inside the network', async () => {
    const key = `test/${randomUUID()}/original`;
    await storage.putObject(key, Buffer.from('internal'), 'video/mp4');

    const url = await storage.presignInternalGetObject(key);
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('internal');
  });
});
