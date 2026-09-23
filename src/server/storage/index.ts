import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import {
  randomUUID,
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  ListObjectVersionsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ImportError } from "@/domain/csv";
import { uploadLimitBytes, uploadLimitLabel } from "@/domain/upload-limit";

export type StoredFile = { key: string; bytes: number; sha256: string };
export const MULTIPART_PART_BYTES = 5 * 1024 * 1024;
type MultipartSession = {
  key: string;
  uploadId: string;
  bytes: number;
  organizationId: string;
  expiresAt: number;
};
export function resolveS3Location(
  key: string,
  bucket: string,
  uploadBucket?: string,
) {
  const incoming = key.startsWith("incoming/");
  const objectKey = incoming ? key.slice("incoming/".length) : key;
  if (!/^[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(objectKey))
    throw new Error("Clé de stockage invalide");
  if (incoming && !uploadBucket)
    throw new Error("Bucket d’upload non configuré");
  return { Bucket: incoming ? uploadBucket! : bucket, Key: objectKey };
}
export interface FileStore {
  put(
    organizationId: string,
    body: ReadableStream<Uint8Array>,
    maxBytes?: number,
  ): Promise<StoredFile>;
  sample(key: string): Promise<Buffer>;
  read(key: string): Readable;
  remove(key: string): Promise<void>;
  signedUrl?(key: string, filename: string): Promise<string>;
  signedUpload?(organizationId: string): Promise<{ key: string; url: string }>;
  beginMultipartUpload?(
    organizationId: string,
    bytes: number,
  ): Promise<{ token: string; partBytes: number }>;
  signMultipartPart?(
    organizationId: string,
    token: string,
    partNumber: number,
  ): Promise<string>;
  finishMultipartUpload?(
    organizationId: string,
    token: string,
  ): Promise<string>;
  abortMultipartUpload?(organizationId: string, token: string): Promise<void>;
}
export class LocalFileStore implements FileStore {
  constructor(private root: string) {}
  private path(key: string) {
    if (!/^[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(key))
      throw new Error("Clé de stockage invalide");
    return resolve(this.root, key);
  }
  async put(
    organizationId: string,
    body: ReadableStream<Uint8Array>,
    maxBytes: number = uploadLimitBytes(),
  ): Promise<StoredFile> {
    const key = `${organizationId}/${randomUUID()}`;
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const hash = createHash("sha256");
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _, callback) {
        bytes += chunk.length;
        if (bytes > maxBytes)
          return callback(
            new ImportError(
              `Le fichier dépasse la limite de ${uploadLimitLabel(maxBytes)}.`,
            ),
          );
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(body as import("node:stream/web").ReadableStream),
        counter,
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
      );
      if (!bytes) throw new ImportError("Le fichier est vide.");
      return { key, bytes, sha256: hash.digest("hex") };
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  }
  async sample(key: string) {
    const handle = await open(this.path(key), "r");
    try {
      const buffer = Buffer.alloc(65_536);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
  read(key: string) {
    return createReadStream(this.path(key));
  }
  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
}

export class S3FileStore implements FileStore {
  private client: S3Client;
  private tokenSecret: string;
  private purgeVersions: boolean;

  constructor(
    private bucket: string,
    options: {
      endpoint: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      uploadBucket?: string;
    },
  ) {
    this.uploadBucket = options.uploadBucket;
    this.tokenSecret = options.secretAccessKey;
    this.purgeVersions = new URL(options.endpoint).hostname.endsWith(
      ".backblazeb2.com",
    );
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  private uploadBucket?: string;

  private encodeSession(session: MultipartSession) {
    const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
    const signature = createHmac("sha256", this.tokenSecret)
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  }

  private decodeSession(
    organizationId: string,
    token: string,
    allowExpired = false,
  ) {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra || token.length > 2048)
      throw new ImportError("Session de transfert invalide.");
    const expected = createHmac("sha256", this.tokenSecret)
      .update(payload)
      .digest();
    const provided = Buffer.from(signature, "base64url");
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    )
      throw new ImportError("Session de transfert invalide.");
    let session: MultipartSession;
    try {
      session = JSON.parse(Buffer.from(payload, "base64url").toString());
    } catch {
      throw new ImportError("Session de transfert invalide.");
    }
    if (
      session.organizationId !== organizationId ||
      (!allowExpired && session.expiresAt < Date.now()) ||
      !Number.isSafeInteger(session.bytes) ||
      session.bytes < 1 ||
      session.bytes > uploadLimitBytes() ||
      typeof session.uploadId !== "string" ||
      !session.uploadId ||
      !session.key.startsWith(`incoming/${organizationId}/`)
    )
      throw new ImportError("Session de transfert invalide ou expirée.");
    resolveS3Location(session.key, this.bucket, this.uploadBucket);
    return session;
  }

  async beginMultipartUpload(organizationId: string, bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > uploadLimitBytes())
      throw new ImportError(
        `Le fichier dépasse la limite de ${uploadLimitLabel()}.`,
      );
    const key = `incoming/${organizationId}/${randomUUID()}`;
    const { Bucket, Key } = resolveS3Location(
      key,
      this.bucket,
      this.uploadBucket,
    );
    const created = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket,
        Key,
        ContentType: "application/octet-stream",
      }),
    );
    if (!created.UploadId) throw new Error("Session S3 non créée.");
    return {
      token: this.encodeSession({
        key,
        uploadId: created.UploadId,
        bytes,
        organizationId,
        expiresAt: Date.now() + 60 * 60 * 1000,
      }),
      partBytes: MULTIPART_PART_BYTES,
    };
  }

  async signMultipartPart(
    organizationId: string,
    token: string,
    partNumber: number,
  ) {
    const session = this.decodeSession(organizationId, token);
    const expectedParts = Math.ceil(session.bytes / MULTIPART_PART_BYTES);
    if (
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > expectedParts
    )
      throw new ImportError("Numéro de partie invalide.");
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        ...resolveS3Location(session.key, this.bucket, this.uploadBucket),
        UploadId: session.uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: 600 },
    );
  }

  async finishMultipartUpload(organizationId: string, token: string) {
    const session = this.decodeSession(organizationId, token);
    const location = resolveS3Location(
      session.key,
      this.bucket,
      this.uploadBucket,
    );
    const listed = await this.client.send(
      new ListPartsCommand({ ...location, UploadId: session.uploadId }),
    );
    const parts = listed.Parts ?? [];
    const expectedParts = Math.ceil(session.bytes / MULTIPART_PART_BYTES);
    if (parts.length !== expectedParts || listed.IsTruncated)
      throw new ImportError("Le transfert est incomplet.");
    for (let index = 0; index < expectedParts; index++) {
      if (
        parts[index].PartNumber !== index + 1 ||
        (parts[index].Size !== undefined &&
          parts[index].Size !==
            (index === expectedParts - 1
              ? session.bytes - index * MULTIPART_PART_BYTES
              : MULTIPART_PART_BYTES)) ||
        !parts[index].ETag
      )
        throw new ImportError("Les parties transférées sont invalides.");
    }
    await this.client.send(
      new CompleteMultipartUploadCommand({
        ...location,
        UploadId: session.uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            ETag: part.ETag,
            PartNumber: part.PartNumber,
          })),
        },
      }),
    );
    const finalObject = await this.client.send(new HeadObjectCommand(location));
    if (finalObject.ContentLength !== session.bytes) {
      await this.remove(session.key).catch(() => undefined);
      throw new ImportError(
        "La taille du fichier transféré ne correspond pas.",
      );
    }
    return session.key;
  }

  async abortMultipartUpload(organizationId: string, token: string) {
    const session = this.decodeSession(organizationId, token, true);
    await this.client.send(
      new AbortMultipartUploadCommand({
        ...resolveS3Location(session.key, this.bucket, this.uploadBucket),
        UploadId: session.uploadId,
      }),
    );
  }

  async put(
    organizationId: string,
    body: ReadableStream<Uint8Array>,
    maxBytes: number = uploadLimitBytes(),
  ): Promise<StoredFile> {
    const key = `${organizationId}/${randomUUID()}`;
    const hash = createHash("sha256");
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _, callback) {
        bytes += chunk.length;
        if (bytes > maxBytes)
          return callback(
            new ImportError(
              `Le fichier dépasse la limite de ${uploadLimitLabel(maxBytes)}.`,
            ),
          );
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const source = Readable.fromWeb(
      body as import("node:stream/web").ReadableStream,
    ).pipe(counter);
    try {
      await new Upload({
        client: this.client,
        params: { Bucket: this.bucket, Key: key, Body: source },
        queueSize: 1,
        partSize: 5 * 1024 * 1024,
        leavePartsOnError: false,
      }).done();
      if (!bytes) throw new ImportError("Le fichier est vide.");
      return { key, bytes, sha256: hash.digest("hex") };
    } catch (error) {
      await this.remove(key).catch(() => undefined);
      throw error;
    }
  }

  async sample(key: string) {
    const result = await this.client.send(
      new GetObjectCommand({
        ...resolveS3Location(key, this.bucket, this.uploadBucket),
        Range: "bytes=0-65535",
      }),
    );
    if (!result.Body) throw new Error("Objet de stockage vide");
    return Buffer.from(await result.Body.transformToByteArray());
  }

  read(key: string) {
    const location = resolveS3Location(key, this.bucket, this.uploadBucket);
    const client = this.client;
    return Readable.from(
      (async function* () {
        const result = await client.send(new GetObjectCommand(location));
        if (!result.Body) throw new Error("Objet introuvable");
        for await (const chunk of result.Body as Readable) yield chunk;
      })(),
    );
  }

  async remove(key: string) {
    const location = resolveS3Location(key, this.bucket, this.uploadBucket);
    await this.client.send(new DeleteObjectCommand(location));
    if (!this.purgeVersions) return;
    const versions: string[] = [];
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    let truncated: boolean;
    do {
      const page = await this.client.send(
        new ListObjectVersionsCommand({
          Bucket: location.Bucket,
          Prefix: location.Key,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        }),
      );
      for (const item of [
        ...(page.Versions ?? []),
        ...(page.DeleteMarkers ?? []),
      ])
        if (item.Key === location.Key && item.VersionId)
          versions.push(item.VersionId);
      truncated = page.IsTruncated ?? false;
      keyMarker = page.NextKeyMarker;
      versionIdMarker = page.NextVersionIdMarker;
      if (truncated && !keyMarker)
        throw new Error("Liste des versions B2 incomplète.");
    } while (truncated);
    for (const versionId of versions)
      await this.client.send(
        new DeleteObjectCommand({ ...location, VersionId: versionId }),
      );
  }

  async signedUrl(key: string, filename: string) {
    const safeName = filename.replace(/["\r\n]/g, "_");
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        ...resolveS3Location(key, this.bucket, this.uploadBucket),
        ResponseContentDisposition: `attachment; filename="${safeName}"`,
      }),
      { expiresIn: 60 },
    );
  }

  async signedUpload(organizationId: string) {
    const objectKey = `${organizationId}/${randomUUID()}`;
    return {
      key: this.uploadBucket ? `incoming/${objectKey}` : objectKey,
      url: await getSignedUrl(
        this.client,
        new PutObjectCommand({
          Bucket: this.uploadBucket ?? this.bucket,
          Key: objectKey,
          ContentType: "application/octet-stream",
        }),
        { expiresIn: 300 },
      ),
    };
  }
}

export function getFileStore(): FileStore {
  if (process.env.STORAGE_DRIVER === "s3") {
    const required = [
      "S3_ENDPOINT",
      "S3_REGION",
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
    ] as const;
    const missing = required.filter((name) => !process.env[name]);
    if (missing.length)
      throw new Error(`Configuration S3 incomplète : ${missing.join(", ")}`);
    return new S3FileStore(process.env.S3_BUCKET!, {
      endpoint: process.env.S3_ENDPOINT!,
      region: process.env.S3_REGION!,
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      uploadBucket: process.env.S3_UPLOAD_BUCKET,
    });
  }
  if (process.env.STORAGE_DRIVER && process.env.STORAGE_DRIVER !== "local")
    throw new Error(`STORAGE_DRIVER inconnu : ${process.env.STORAGE_DRIVER}`);
  return new LocalFileStore(
    resolve(process.env.LOCAL_STORAGE_DIR ?? ".local/uploads"),
  );
}
