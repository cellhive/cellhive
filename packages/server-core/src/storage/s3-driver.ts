import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { contentDisposition } from './content-disposition.js';
import { assertValidExpiry, assertValidStorageKey } from './storage-key.js';

import type {
  PutObjectOptions,
  PutStreamOptions,
  PresignedRequest,
  PresignGetOptions,
  PresignPutOptions,
  StorageDriver,
  StoredObjectInfo,
} from './storage-driver.js';
import type { Readable } from 'node:stream';

export interface S3StorageDriverOptions {
  /** Endpoint for server-side calls (S3_ENDPOINT); `null` = AWS default. */
  readonly endpoint: string | null;
  /** Endpoint presigned URLs are signed for (S3_PUBLIC_ENDPOINT); `null` = AWS default. */
  readonly publicEndpoint: string | null;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
  /** Timeout of server-side calls in milliseconds (default 10 s). */
  readonly requestTimeoutMs?: number;
}

function clientConfig(options: S3StorageDriverOptions, endpoint: string | null): S3ClientConfig {
  return {
    region: options.region,
    ...(endpoint === null ? {} : { endpoint }),
    forcePathStyle: options.forcePathStyle,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
    // Newer SDKs add CRC checksums to every request by default, which presigned
    // browser uploads cannot provide and several S3-compatible servers reject.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 2,
    requestHandler: {
      connectionTimeout: 3_000,
      requestTimeout: options.requestTimeoutMs ?? 10_000,
    },
  };
}

function httpStatusOf(error: unknown): number | undefined {
  const metadata = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata;
  return typeof metadata?.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined;
}

/**
 * S3-compatible object storage (Garage by default, ADR-0016). Uses only the
 * API subset Garage supports: PUT/GET/HEAD/DELETE object, HEAD bucket and
 * presigned PUT/GET.
 *
 * Server-side calls go to `endpoint` (internal network); presigned URLs are
 * signed for `publicEndpoint`, because SigV4 covers the host the browser
 * connects to.
 */
export class S3StorageDriver implements StorageDriver {
  readonly kind = 's3' as const;
  private readonly bucket: string;
  private readonly client: S3Client;
  private readonly presignClient: S3Client;

  constructor(options: S3StorageDriverOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client(clientConfig(options, options.endpoint));
    // Signing is local; this client never sends a request.
    this.presignClient = new S3Client(clientConfig(options, options.publicEndpoint));
  }

  async presignPut(key: string, options: PresignPutOptions): Promise<PresignedRequest> {
    assertValidStorageKey(key);
    assertValidExpiry(options.expiresIn);
    const signedAt = Date.now();
    const sized = options.contentLength !== undefined;
    const url = await getSignedUrl(
      this.presignClient,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: options.contentType,
        ...(sized ? { ContentLength: options.contentLength } : {}),
      }),
      // Sign Content-Type (and Content-Length when known) so that the upload cannot change them.
      {
        expiresIn: options.expiresIn,
        signableHeaders: new Set(sized ? ['content-type', 'content-length'] : ['content-type']),
      },
    );
    return {
      method: 'PUT',
      url,
      headers: { 'content-type': options.contentType },
      expiresAt: new Date(signedAt + options.expiresIn * 1000),
    };
  }

  async presignGet(key: string, options: PresignGetOptions): Promise<PresignedRequest> {
    assertValidStorageKey(key);
    assertValidExpiry(options.expiresIn);
    const signedAt = Date.now();
    const url = await getSignedUrl(
      this.presignClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: contentDisposition(
          options.filename,
          options.disposition ?? 'attachment',
        ),
      }),
      { expiresIn: options.expiresIn },
    );
    return {
      method: 'GET',
      url,
      headers: {},
      expiresAt: new Date(signedAt + options.expiresIn * 1000),
    };
  }

  async put(key: string, body: Uint8Array, options: PutObjectOptions): Promise<StoredObjectInfo> {
    assertValidStorageKey(key);
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType,
        ContentLength: body.byteLength,
      }),
    );
    return {
      size: body.byteLength,
      contentType: options.contentType,
      etag: result.ETag ?? null,
      lastModified: null,
    };
  }

  async putStream(
    key: string,
    body: Readable,
    options: PutStreamOptions,
  ): Promise<StoredObjectInfo> {
    assertValidStorageKey(key);
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType,
        ContentLength: options.contentLength,
      }),
    );
    return {
      size: options.contentLength,
      contentType: options.contentType,
      etag: result.ETag ?? null,
      lastModified: null,
    };
  }

  async getStream(key: string): Promise<Readable | null> {
    assertValidStorageKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      // The Node.js SDK returns the body as an `IncomingMessage` (a `Readable`).
      return (result.Body as Readable | undefined) ?? null;
    } catch (error) {
      if (httpStatusOf(error) === 404) return null;
      throw error;
    }
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    assertValidStorageKey(key);
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: result.ContentLength ?? 0,
        contentType: result.ContentType ?? null,
        etag: result.ETag ?? null,
        lastModified: result.LastModified ?? null,
      };
    } catch (error) {
      if (httpStatusOf(error) === 404) return null;
      throw error;
    }
  }

  async move(fromKey: string, toKey: string): Promise<boolean> {
    assertValidStorageKey(fromKey);
    assertValidStorageKey(toKey);
    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          // Keys match STORAGE_KEY_PATTERN: nothing to percent-encode.
          CopySource: `${this.bucket}/${fromKey}`,
          Key: toKey,
          MetadataDirective: 'COPY',
        }),
      );
    } catch (error) {
      if (httpStatusOf(error) === 404) return false;
      throw error;
    }
    await this.delete(fromKey);
    return true;
  }

  async delete(key: string): Promise<void> {
    assertValidStorageKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async health(signal?: AbortSignal): Promise<void> {
    await this.client.send(
      new HeadBucketCommand({ Bucket: this.bucket }),
      signal === undefined ? {} : { abortSignal: signal },
    );
  }

  close(): Promise<void> {
    this.client.destroy();
    this.presignClient.destroy();
    return Promise.resolve();
  }
}
