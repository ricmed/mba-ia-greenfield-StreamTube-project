import { S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageModule', () => {
  it('should compile and provide two S3 clients bound to different endpoints', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    })
      // onModuleInit would hit the storage; the module wiring is what this test covers.
      .overrideProvider(StorageService)
      .useValue({ onModuleInit: jest.fn() })
      .compile();

    const internal = module.get<S3Client>(S3_INTERNAL_CLIENT);
    const publicClient = module.get<S3Client>(S3_PUBLIC_CLIENT);

    expect(internal).toBeInstanceOf(S3Client);
    expect(publicClient).toBeInstanceOf(S3Client);

    const internalEndpoint = await internal.config.endpoint!();
    const publicEndpoint = await publicClient.config.endpoint!();

    expect(internalEndpoint.hostname).not.toBe(publicEndpoint.hostname);
    await module.close();
  });
});
