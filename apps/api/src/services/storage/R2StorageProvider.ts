import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { STORAGE_KEY, type StorageProvider } from './StorageProvider';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Another S3-compatible endpoint (tests). Defaults to the account's R2 endpoint. */
  endpoint?: string;
}

/**
 * Private files in a Cloudflare R2 bucket, through R2's S3-compatible API.
 *
 * The bucket stays private: no public access, no custom domain. A browser
 * gets a presigned GET URL that expires (R2 allows 1 second to 7 days; we
 * use minutes). Presigned URLs only work on the S3 endpoint host,
 * <account>.r2.cloudflarestorage.com, which is why that host is in the
 * Content-Security-Policy.
 */
export class R2StorageProvider implements StorageProvider {
  readonly name = 'r2' as const;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: R2Config) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: 'auto',
      endpoint: config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // Path-style (/bucket/key) keeps every URL on the one endpoint host.
      forcePathStyle: true,
    });
  }

  private checked(key: string): string {
    if (!STORAGE_KEY.test(key)) throw new Error(`Bad storage key: ${key}`);
    return key;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: this.checked(key), Body: body, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.checked(key) }));
    if (!res.Body) throw new Error(`Empty object: ${key}`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    // S3 semantics: deleting a missing key succeeds.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.checked(key) }));
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.checked(key),
        ResponseContentDisposition: 'inline',
        ResponseCacheControl: `private, max-age=${ttlSeconds}`,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  async check(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { ok: true, detail: `Bucket ${this.bucket} reachable` };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      return { ok: false, detail: `Bucket ${this.bucket} not reachable${status ? ` (HTTP ${status})` : ''}` };
    }
  }
}
