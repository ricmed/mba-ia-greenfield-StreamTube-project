import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY: 'access-key',
  S3_SECRET_KEY: 'secret-key',
  S3_BUCKET: 'bucket',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage (phase 03)', () => {
  it.each(['S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET'])(
    'should reject when %s is missing',
    (key) => {
      const env = { ...requiredEnv };
      delete (env as Record<string, string>)[key];
      const { error } = envValidationSchema.validate(env, {
        allowUnknown: true,
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should apply the internal and public endpoint defaults separately', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.S3_ENDPOINT).toBe('http://minio:9000');
    expect(value.S3_PUBLIC_ENDPOINT).toBe('http://localhost:9000');
  });

  it('should reject a part size below the 5 MiB S3 minimum', () => {
    const { error } = validate({ VIDEO_PART_SIZE_BYTES: '1048576' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_PART_SIZE_BYTES');
  });

  it('should reject a delivery URL expiration above the 7-day S3 ceiling', () => {
    const { error } = validate({ VIDEO_URL_EXPIRATION_SECONDS: '604801' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_URL_EXPIRATION_SECONDS');
  });

  it('should default the upload limit to 10 GiB and the part size to 64 MiB', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.VIDEO_MAX_SIZE_BYTES).toBe(10737418240);
    expect(value.VIDEO_PART_SIZE_BYTES).toBe(67108864);
  });
});

describe('envValidationSchema — queue (phase 03)', () => {
  it('should default the queue host to the Compose service name', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
  });

  it('should reject a non-numeric Redis port', () => {
    const { error } = validate({ REDIS_PORT: 'not-a-port' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_PORT');
  });
});
