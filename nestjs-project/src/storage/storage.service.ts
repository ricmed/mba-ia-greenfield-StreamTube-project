import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';

export interface PresignedPart {
  partNumber: number;
  url: string;
  expiresAt: Date;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(S3_PUBLIC_CLIENT) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  /** Idempotent bootstrap: the bucket and its CORS policy must exist before any upload. */
  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  async ensureBucket(): Promise<void> {
    const Bucket = this.storage.bucket;

    try {
      await this.internalClient.send(new HeadBucketCommand({ Bucket }));
    } catch {
      await this.internalClient.send(new CreateBucketCommand({ Bucket }));
      this.logger.log(`Created storage bucket "${Bucket}"`);
    }

    // Browsers PUT parts straight to the storage and must read each part's
    // ETag to complete the multipart upload (phase-03-videos/TD-02).
    try {
      await this.internalClient.send(
        new PutBucketCorsCommand({
          Bucket,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: ['*'],
                AllowedMethods: ['GET', 'PUT', 'HEAD'],
                AllowedHeaders: ['*'],
                ExposeHeaders: ['ETag'],
                MaxAgeSeconds: 3000,
              },
            ],
          },
        }),
      );
    } catch (err) {
      // MinIO historically answers NotImplemented to PutBucketCors and relies
      // on the server-level MINIO_API_CORS_ALLOW_ORIGIN instead (set in
      // compose.yaml). Real S3 applies the rule above.
      this.logger.warn(
        `Bucket CORS not applied via API (${(err as Error).name}); relying on the storage server configuration.`,
      );
    }
  }

  async createMultipartUpload(key: string, contentType: string): Promise<string> {
    const response = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.storage.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );

    if (!response.UploadId) {
      throw new Error('Storage did not return an UploadId');
    }

    return response.UploadId;
  }

  /** Signs one URL per part against the PUBLIC endpoint — the client uploads directly. */
  async presignUploadParts(
    key: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<PresignedPart[]> {
    const expiresIn = this.storage.urlExpirationSeconds;

    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await getSignedUrl(
          this.publicClient,
          new UploadPartCommand({
            Bucket: this.storage.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
          }),
          { expiresIn },
        ),
        expiresAt: new Date(Date.now() + expiresIn * 1000),
      })),
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.internalClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.storage.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts
            .slice()
            .sort((a, b) => a.partNumber - b.partNumber)
            .map(({ partNumber, etag }) => ({
              PartNumber: partNumber,
              ETag: etag,
            })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.internalClient.send(
      new AbortMultipartUploadCommand({
        Bucket: this.storage.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async headObject(key: string): Promise<{ contentLength: number }> {
    const response = await this.internalClient.send(
      new HeadObjectCommand({ Bucket: this.storage.bucket, Key: key }),
    );

    return { contentLength: response.ContentLength ?? 0 };
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.storage.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /** Delivery URL for clients — signed against the PUBLIC endpoint. */
  async presignGetObject(
    key: string,
    options: { downloadFilename?: string } = {},
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: this.storage.bucket,
        Key: key,
        ...(options.downloadFilename && {
          ResponseContentDisposition: `attachment; filename="${options.downloadFilename.replace(/"/g, '')}"`,
        }),
      }),
      { expiresIn: this.storage.urlExpirationSeconds },
    );
  }

  /**
   * Delivery URL for server-side consumers (the worker feeds it to ffprobe /
   * ffmpeg, which seek over HTTP Range instead of downloading the whole file).
   */
  async presignInternalGetObject(key: string): Promise<string> {
    return getSignedUrl(
      this.internalClient,
      new GetObjectCommand({ Bucket: this.storage.bucket, Key: key }),
      { expiresIn: this.storage.urlExpirationSeconds },
    );
  }
}
