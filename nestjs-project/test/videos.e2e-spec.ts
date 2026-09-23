import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Queue, QueueEvents } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { fetchSignedUrl } from '../src/test/signed-url';
import {
  createCorruptFixture,
  createVideoFixture,
} from '../src/test/video-fixture';
import { VIDEO_PROCESSING } from '../src/videos/video-processing.constants';
import { WorkerModule } from '../src/videos/worker.module';

// Assigned before any Nest container is built, because the config factories
// read process.env when the module initialises. The suite runs the queue under
// its own Redis prefix so the `video-worker` container of the Compose stack,
// which shares this Redis, cannot consume the jobs enqueued here
// (phase-03-videos/TD-12).
process.env.QUEUE_PREFIX = 'bull-e2e';

const VALID_BODY = {
  title: 'My first video',
  filename: 'my-first-video.mp4',
  size_bytes: 120 * 1024 * 1024,
  mime_type: 'video/mp4',
};

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let storageService: StorageService;
  let workerModule: TestingModule;
  let queue: Queue;
  let queueEvents: QueueEvents;
  let counter = 0;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    storageService = moduleFixture.get(StorageService);
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING.QUEUE));

    // The worker runs inside the test process, on the code of this checkout,
    // instead of relying on the container (phase-03-videos/TD-12).
    workerModule = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await workerModule.init();

    queueEvents = new QueueEvents(VIDEO_PROCESSING.QUEUE, {
      connection: queue.opts.connection,
      prefix: queue.opts.prefix,
    });
    await queueEvents.waitUntilReady();
  });

  afterAll(async () => {
    // Obliterate before closing: leaving jobs under the test prefix would make
    // the next run start with work already queued.
    await queue.obliterate({ force: true });
    await queueEvents.close();
    await workerModule.close();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  /** Registers, confirms and logs in a user, returning its access token. */
  async function authenticate(): Promise<string> {
    const email = `video_e2e_${++counter}@example.com`;
    const password = 'password123';

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);

    // Confirming through the API would need the raw token from the e-mail;
    // this suite is about videos, so the account is confirmed directly.
    await dataSource.query(
      `UPDATE "users" SET "is_confirmed" = true WHERE "email" = $1`,
      [email],
    );

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    return (login.body as { access_token: string }).access_token;
  }

  describe('POST /videos', () => {
    it('should return 201 with the draft and the multipart upload handle', async () => {
      const accessToken = await authenticate();

      const response = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(VALID_BODY)
        .expect(201);

      expect(response.body.id).toHaveLength(11);
      expect(response.body.status).toBe('draft');
      expect(response.body.processing_status).toBe('uploading');
      expect(response.body.upload.upload_id).toBeTruthy();
      expect(response.body.upload.part_size).toBe(67108864);
      expect(response.body.upload.part_count).toBe(2);
    });

    it('should return 401 without an access token', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send(VALID_BODY)
        .expect(401);
    });

    it('should return 400 when the body fails schema validation', async () => {
      const accessToken = await authenticate();

      const response = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...VALID_BODY, title: '' })
        .expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when the body carries unknown fields', async () => {
      const accessToken = await authenticate();

      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...VALID_BODY, unexpected: 'field' })
        .expect(400);
    });

    it('should return 413 when the declared size exceeds the limit', async () => {
      const accessToken = await authenticate();

      const response = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...VALID_BODY, size_bytes: 10737418241 })
        .expect(413);

      expect(response.body.error).toBe('FILE_TOO_LARGE');
    });

    it('should return 415 when the mime type is not a video', async () => {
      const accessToken = await authenticate();

      const response = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...VALID_BODY, mime_type: 'application/pdf' })
        .expect(415);

      expect(response.body.error).toBe('UNSUPPORTED_MEDIA_TYPE');
    });
  });

  describe('POST /videos/:publicId/upload/parts', () => {
    async function createDraft(accessToken: string): Promise<string> {
      const response = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(VALID_BODY)
        .expect(201);

      return (response.body as { id: string }).id;
    }

    it('should return 200 with usable presigned part urls', async () => {
      const accessToken = await authenticate();
      const publicId = await createDraft(accessToken);

      const response = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/parts`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ part_numbers: [1, 2] })
        .expect(200);

      const parts = (
        response.body as {
          parts: { part_number: number; url: string; expires_at: string }[];
        }
      ).parts;

      expect(parts).toHaveLength(2);
      expect(parts[0].url).not.toBe(parts[1].url);
      expect(new Date(parts[0].expires_at).getTime()).toBeGreaterThan(
        Date.now(),
      );

      // The URL really accepts the bytes and answers with an ETag.
      const upload = await fetchSignedUrl(parts[0].url, {
        method: 'PUT',
        body: Buffer.alloc(5 * 1024 * 1024, 'a'),
      });
      expect(upload.status).toBe(200);
      expect(upload.headers.get('etag')).toBeTruthy();
    });

    it('should return 403 when the caller does not own the video', async () => {
      const ownerToken = await authenticate();
      const publicId = await createDraft(ownerToken);
      const otherToken = await authenticate();

      const response = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/parts`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ part_numbers: [1] })
        .expect(403);

      expect(response.body.error).toBe('NOT_VIDEO_OWNER');
    });

    it('should return 404 for an unknown public id', async () => {
      const accessToken = await authenticate();

      const response = await request(app.getHttpServer())
        .post('/videos/doesnotexi/upload/parts')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ part_numbers: [1] })
        .expect(404);

      expect(response.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('should return 400 when part_numbers is empty', async () => {
      const accessToken = await authenticate();
      const publicId = await createDraft(accessToken);

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/parts`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ part_numbers: [] })
        .expect(400);
    });

    it('should return 400 when a part number is out of range', async () => {
      const accessToken = await authenticate();
      const publicId = await createDraft(accessToken);

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/parts`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ part_numbers: [0] })
        .expect(400);
    });
  });

  describe('upload completion and cancellation', () => {
    const PART_SIZE = 5 * 1024 * 1024;

    async function uploadOnePart(
      accessToken: string,
      body: Buffer,
    ): Promise<{ publicId: string; etag: string }> {
      const draft = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...VALID_BODY, size_bytes: body.length })
        .expect(201);

      const publicId = (draft.body as { id: string }).id;

      const signed = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/parts`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ part_numbers: [1] })
        .expect(200);

      const url = (signed.body as { parts: { url: string }[] }).parts[0].url;
      const upload = await fetchSignedUrl(url, { method: 'PUT', body });
      expect(upload.status).toBe(200);

      return { publicId, etag: upload.headers.get('etag')! };
    }

    it('should return 200 and move the video to processing', async () => {
      const accessToken = await authenticate();
      const { publicId, etag } = await uploadOnePart(
        accessToken,
        Buffer.alloc(PART_SIZE, 'a'),
      );

      const response = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(200);

      expect(response.body.id).toBe(publicId);
      expect(response.body.status).toBe('draft');
      expect(response.body.processing_status).toBe('processing');
    });

    it('should return 200 on a repeated completion (idempotent)', async () => {
      const accessToken = await authenticate();
      const { publicId, etag } = await uploadOnePart(
        accessToken,
        Buffer.alloc(PART_SIZE, 'b'),
      );
      const body = { parts: [{ part_number: 1, etag }] };

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send(body)
        .expect(200);

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send(body)
        .expect(200);
    });

    it('should return 422 when the assembled size differs from the declared one', async () => {
      const accessToken = await authenticate();

      // Declares 10 MiB but uploads a single 5 MiB part.
      const draft = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...VALID_BODY, size_bytes: PART_SIZE * 2 })
        .expect(201);
      const publicId = (draft.body as { id: string }).id;

      const signed = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/parts`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ part_numbers: [1] })
        .expect(200);

      const url = (signed.body as { parts: { url: string }[] }).parts[0].url;
      const upload = await fetchSignedUrl(url, {
        method: 'PUT',
        body: Buffer.alloc(PART_SIZE, 'c'),
      });

      const response = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          parts: [{ part_number: 1, etag: upload.headers.get('etag')! }],
        })
        .expect(422);

      expect(response.body.error).toBe('UPLOAD_SIZE_MISMATCH');

      const stillUploading = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/parts`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ part_numbers: [2] });
      expect(stillUploading.status).toBe(200);
    });

    it('should return 400 when parts entries are malformed', async () => {
      const accessToken = await authenticate();
      const { publicId } = await uploadOnePart(
        accessToken,
        Buffer.alloc(PART_SIZE, 'd'),
      );

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ part_number: 1 }] })
        .expect(400);
    });

    it('should return 204 and drop the draft on abort', async () => {
      const accessToken = await authenticate();
      const draft = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(VALID_BODY)
        .expect(201);
      const publicId = (draft.body as { id: string }).id;

      await request(app.getHttpServer())
        .delete(`/videos/${publicId}/upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/parts`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ part_numbers: [1] })
        .expect(404);
    });

    it('should return 409 when aborting a video that is already processing', async () => {
      const accessToken = await authenticate();
      const { publicId, etag } = await uploadOnePart(
        accessToken,
        Buffer.alloc(PART_SIZE, 'e'),
      );

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(200);

      const response = await request(app.getHttpServer())
        .delete(`/videos/${publicId}/upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(409);

      expect(response.body.error).toBe('UPLOAD_NOT_IN_PROGRESS');
    });
  });

  describe('GET /videos/:publicId', () => {
    /** Creates a draft and marks it ready as the worker would. */
    async function readyVideo(accessToken: string): Promise<string> {
      const draft = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(VALID_BODY)
        .expect(201);

      const publicId = (draft.body as { id: string }).id;
      await dataSource.query(
        `UPDATE "videos"
         SET "processing_status" = 'ready',
             "duration_seconds" = 42,
             "metadata" = $2,
             "thumbnail_key" = 'videos/' || "id" || '/thumbnail.jpg'
         WHERE "public_id" = $1`,
        [publicId, JSON.stringify({ width: 1280, height: 720 })],
      );

      return publicId;
    }

    it('should return 200 with metadata and a thumbnail url for anonymous viewers', async () => {
      const accessToken = await authenticate();
      const publicId = await readyVideo(accessToken);

      const response = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .expect(200);

      expect(response.body.id).toBe(publicId);
      expect(response.body.status).toBe('draft');
      expect(response.body.processing_status).toBe('ready');
      expect(response.body.duration_seconds).toBe(42);
      expect(response.body.metadata.width).toBe(1280);
      expect(response.body.thumbnail_url).toContain('X-Amz-Signature');
    });

    it('should let the owner see a video that is still processing', async () => {
      const accessToken = await authenticate();
      const draft = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(VALID_BODY)
        .expect(201);
      const publicId = (draft.body as { id: string }).id;

      const response = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.processing_status).toBe('uploading');
      expect(response.body.thumbnail_url).toBeNull();
    });

    it('should hide a video still processing from an anonymous viewer', async () => {
      const accessToken = await authenticate();
      const draft = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(VALID_BODY)
        .expect(201);
      const publicId = (draft.body as { id: string }).id;

      const response = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .expect(404);

      expect(response.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('should answer the same 404 for a draft of another channel and for an unknown id', async () => {
      const ownerToken = await authenticate();
      const draft = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(VALID_BODY)
        .expect(201);
      const publicId = (draft.body as { id: string }).id;
      const otherToken = await authenticate();

      const foreignDraft = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404);

      const unknown = await request(app.getHttpServer())
        .get('/videos/doesnotexi')
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404);

      expect(foreignDraft.body).toEqual(unknown.body);
    });

    it('should expose the failure reason to the owner', async () => {
      const accessToken = await authenticate();
      const draft = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(VALID_BODY)
        .expect(201);
      const publicId = (draft.body as { id: string }).id;

      await dataSource.query(
        `UPDATE "videos"
         SET "processing_status" = 'failed', "processing_error" = 'ffprobe rejected the file'
         WHERE "public_id" = $1`,
        [publicId],
      );

      const response = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.processing_status).toBe('failed');
      expect(response.body.processing_error).toBe('ffprobe rejected the file');
    });
  });

  describe('delivery (stream and download)', () => {
    const CONTENT = Buffer.alloc(64 * 1024, 'z');

    /**
     * Puts a real object in the storage under the draft's key and marks the
     * video ready, as the worker would. The bytes are written directly instead
     * of going through the multipart completion so the running worker does not
     * race this test by flipping the status while it asserts — the full flow
     * with the real worker is covered in SI-03.13.
     */
    async function readyVideoWithBytes(accessToken: string): Promise<string> {
      const draft = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...VALID_BODY, size_bytes: CONTENT.length })
        .expect(201);

      const publicId = (draft.body as { id: string }).id;
      const [{ storage_key }] = await dataSource.query<
        { storage_key: string }[]
      >(`SELECT "storage_key" FROM "videos" WHERE "public_id" = $1`, [
        publicId,
      ]);

      await storageService.putObject(storage_key, CONTENT, 'video/mp4');
      await dataSource.query(
        `UPDATE "videos"
         SET "processing_status" = 'ready', "upload_id" = NULL
         WHERE "public_id" = $1`,
        [publicId],
      );

      return publicId;
    }

    it('should redirect an anonymous viewer to the storage without carrying bytes', async () => {
      const accessToken = await authenticate();
      const publicId = await readyVideoWithBytes(accessToken);

      const response = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .expect(302);

      expect(response.headers.location).toContain('X-Amz-Signature');
      expect(response.headers['cache-control']).toBe('no-store');
      // The redirect itself is empty: no video byte goes through the API.
      expect(response.body).toEqual({});
    });

    it('should serve a byte range from the redirect target without downloading the whole file', async () => {
      const accessToken = await authenticate();
      const publicId = await readyVideoWithBytes(accessToken);

      const redirect = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .expect(302);

      const ranged = await fetchSignedUrl(redirect.headers.location, {
        headers: { range: 'bytes=0-1023' },
      });

      expect(ranged.status).toBe(206);
      expect(ranged.headers.get('content-range')).toBe(
        `bytes 0-1023/${CONTENT.length}`,
      );
      expect(ranged.headers.get('accept-ranges')).toBe('bytes');

      const body = await ranged.buffer();
      expect(body).toHaveLength(1024);
      expect(body.equals(CONTENT.subarray(0, 1024))).toBe(true);
    });

    it('should hand the download the original filename as an attachment', async () => {
      const accessToken = await authenticate();
      const publicId = await readyVideoWithBytes(accessToken);

      const redirect = await request(app.getHttpServer())
        .get(`/videos/${publicId}/download`)
        .expect(302);

      const download = await fetchSignedUrl(redirect.headers.location);

      expect(download.status).toBe(200);
      expect(download.headers.get('content-disposition')).toBe(
        `attachment; filename="${VALID_BODY.filename}"`,
      );
      expect(await download.buffer()).toHaveLength(CONTENT.length);
    });

    it.each(['stream', 'download'])(
      'should return 409 on %s while the video is not ready',
      async (route) => {
        const accessToken = await authenticate();
        const draft = await request(app.getHttpServer())
          .post('/videos')
          .set('Authorization', `Bearer ${accessToken}`)
          .send(VALID_BODY)
          .expect(201);
        const publicId = (draft.body as { id: string }).id;

        // Not even the owner gets a delivery URL before processing ends.
        const response = await request(app.getHttpServer())
          .get(`/videos/${publicId}/${route}`)
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(409);

        expect(response.body.error).toBe('VIDEO_NOT_READY');
      },
    );

    it.each(['stream', 'download'])(
      'should return 404 on %s for an unknown public id',
      async (route) => {
        const response = await request(app.getHttpServer())
          .get(`/videos/doesnotexi/${route}`)
          .expect(404);

        expect(response.body.error).toBe('VIDEO_NOT_FOUND');
      },
    );
  });
  describe('fluxo completo: upload, processamento e entrega', () => {
    /**
     * Runs the real client flow: opens the draft, uploads the bytes straight
     * to the storage and closes the multipart upload, which enqueues the job.
     */
    async function uploadAndComplete(
      accessToken: string,
      content: Buffer,
    ): Promise<{ publicId: string; videoId: string }> {
      const draft = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...VALID_BODY, size_bytes: content.length })
        .expect(201);

      const publicId = (draft.body as { id: string }).id;

      const signed = await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/parts`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ part_numbers: [1] })
        .expect(200);

      const url = (signed.body as { parts: { url: string }[] }).parts[0].url;
      const upload = await fetchSignedUrl(url, {
        method: 'PUT',
        body: content,
      });
      expect(upload.status).toBe(200);

      await request(app.getHttpServer())
        .post(`/videos/${publicId}/upload/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          parts: [{ part_number: 1, etag: upload.headers.get('etag')! }],
        })
        .expect(200);

      // The job id is the internal uuid, not the public one.
      const [{ id }] = await dataSource.query<{ id: string }[]>(
        `SELECT "id" FROM "videos" WHERE "public_id" = $1`,
        [publicId],
      );

      return { publicId, videoId: id };
    }

    /**
     * Deterministic wait: resolves on the job's own completion event instead
     * of polling the database on a timer.
     */
    async function processingOf(videoId: string): Promise<unknown> {
      const job = await queue.getJob(videoId);
      expect(job).toBeDefined();
      return job!.waitUntilFinished(queueEvents, 60_000);
    }

    it('leva um vídeo real de upload a ready, com metadados, thumbnail, stream e download', async () => {
      const accessToken = await authenticate();
      const content = await createVideoFixture({
        durationSeconds: 2,
        width: 320,
        height: 240,
      });

      const { publicId, videoId } = await uploadAndComplete(
        accessToken,
        content,
      );
      await processingOf(videoId);

      const details = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .expect(200);

      expect(details.body.processing_status).toBe('ready');
      expect(details.body.processing_error).toBeNull();
      expect(details.body.duration_seconds).toBe(2);
      expect(details.body.metadata.width).toBe(320);
      expect(details.body.metadata.height).toBe(240);
      expect(details.body.metadata.video_codec).toBe('h264');

      // The thumbnail is a real object the worker wrote, not just a key.
      const thumbnail = await fetchSignedUrl(details.body.thumbnail_url);
      expect(thumbnail.status).toBe(200);
      expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
      expect((await thumbnail.buffer()).length).toBeGreaterThan(0);

      const streamRedirect = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .expect(302);
      const ranged = await fetchSignedUrl(streamRedirect.headers.location, {
        headers: { range: 'bytes=0-1023' },
      });

      expect(ranged.status).toBe(206);
      expect(ranged.headers.get('content-range')).toBe(
        `bytes 0-1023/${content.length}`,
      );

      const downloadRedirect = await request(app.getHttpServer())
        .get(`/videos/${publicId}/download`)
        .expect(302);
      const download = await fetchSignedUrl(downloadRedirect.headers.location);

      expect(download.status).toBe(200);
      expect(download.headers.get('content-disposition')).toBe(
        `attachment; filename="${VALID_BODY.filename}"`,
      );
      // The bytes that come back are the ones that went up.
      expect((await download.buffer()).equals(content)).toBe(true);
    }, 120_000);

    it('deixa em failed, com o motivo preenchido, um arquivo que o ffprobe rejeita', async () => {
      const accessToken = await authenticate();
      const { publicId, videoId } = await uploadAndComplete(
        accessToken,
        createCorruptFixture(),
      );

      await expect(processingOf(videoId)).rejects.toThrow();

      // Not ready, so only the owner sees it.
      const details = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(details.body.processing_status).toBe('failed');
      expect(details.body.processing_error).toBeTruthy();
      expect(details.body.thumbnail_url).toBeNull();

      await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .expect(409);
    }, 120_000);
  });
});
