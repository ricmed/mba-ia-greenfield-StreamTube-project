import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { fetchSignedUrl } from '../src/test/signed-url';

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
  });

  afterAll(async () => {
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
});
