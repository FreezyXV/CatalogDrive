import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { LIMITS, ImportError } from "@/domain/csv";

export type StoredFile = { key: string; bytes: number; sha256: string };
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
    maxBytes: number = LIMITS.bytes,
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
              `Le fichier dépasse la limite de ${Math.round(maxBytes / 1024 / 1024)} Mio.`,
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

  async put(
    organizationId: string,
    body: ReadableStream<Uint8Array>,
    maxBytes: number = LIMITS.bytes,
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
              `Le fichier dépasse la limite de ${Math.round(maxBytes / 1024 / 1024)} Mio.`,
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
    const output = new Readable({ read() {} });
    void this.client
      .send(new GetObjectCommand(location))
      .then((result) => {
        if (!result.Body) return output.destroy(new Error("Objet introuvable"));
        const source = result.Body as NodeJS.ReadableStream;
        source.on("data", (chunk) => output.push(chunk));
        source.on("end", () => output.push(null));
        source.on("error", (error) => output.destroy(error));
      })
      .catch((error) => output.destroy(error));
    return output;
  }

  async remove(key: string) {
    await this.client.send(
      new DeleteObjectCommand(
        resolveS3Location(key, this.bucket, this.uploadBucket),
      ),
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
