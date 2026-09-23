import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  LocalFileStore,
  S3FileStore,
  resolveS3Location,
} from "../../src/server/storage";
import { SMALL_UPLOAD_BYTES } from "../../src/domain/upload-limit";
const dirs: string[] = [];
async function storage() {
  const dir = await mkdtemp(join(tmpdir(), "catamotive-test-"));
  dirs.push(dir);
  return { dir, store: new LocalFileStore(dir), org: randomUUID() };
}
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
describe("stockage local réel", () => {
  it("conserve exactement les octets, formules comprises", async () => {
    const { store, org } = await storage();
    const original = Buffer.from("\ufeffref;nom\r\n001;=SUM(1+2)\r\n");
    const saved = await store.put(org, new Blob([original]).stream());
    expect(saved.sha256).toBe(
      createHash("sha256").update(original).digest("hex"),
    );
    const chunks: Buffer[] = [];
    for await (const chunk of store.read(saved.key))
      chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(original);
    await store.remove(saved.key);
    await expect(store.sample(saved.key)).rejects.toThrow();
  });
  it("refuse réellement un flux > 5 Mio et retire son fichier partiel", async () => {
    const { store, org, dir } = await storage();
    const previous = process.env.UPLOAD_MAX_BYTES;
    process.env.UPLOAD_MAX_BYTES = String(SMALL_UPLOAD_BYTES);
    let count = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (count++ < 6) controller.enqueue(new Uint8Array(1024 * 1024));
        else controller.close();
      },
    });
    try {
      await expect(store.put(org, body)).rejects.toThrow("5 Mio");
      expect(await readdir(join(dir, org))).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.UPLOAD_MAX_BYTES;
      else process.env.UPLOAD_MAX_BYTES = previous;
    }
  });
  it("accepte un fichier de 6 Mio avec le plafond explicite de 50 Mo", async () => {
    const { store, org } = await storage();
    const previous = process.env.UPLOAD_MAX_BYTES;
    process.env.UPLOAD_MAX_BYTES = "50000000";
    try {
      const data = Buffer.concat([
        Buffer.from("ref;nom\n"),
        Buffer.alloc(6 * 1024 * 1024, 65),
      ]);
      const saved = await store.put(
        org,
        new Blob([new Uint8Array(data)]).stream(),
      );
      expect(saved.bytes).toBeGreaterThan(5 * 1024 * 1024);
      expect(saved.sha256).toBe(
        createHash("sha256").update(data).digest("hex"),
      );
      await store.remove(saved.key);
    } finally {
      if (previous === undefined) delete process.env.UPLOAD_MAX_BYTES;
      else process.env.UPLOAD_MAX_BYTES = previous;
    }
  });
  it("refuse le fichier vide et les clés de traversée", async () => {
    const { store, org } = await storage();
    await expect(store.put(org, new Blob([]).stream())).rejects.toThrow("vide");
    expect(() => store.read("../../secret")).toThrow("Clé");
  });
});
describe("routage S3 des imports", () => {
  it("garde les anciens objets et isole les nouveaux uploads dans le bucket plafonné", () => {
    const key = `${randomUUID()}/${randomUUID()}`;
    expect(resolveS3Location(key, "archive", "uploads")).toEqual({
      Bucket: "archive",
      Key: key,
    });
    expect(resolveS3Location(`incoming/${key}`, "archive", "uploads")).toEqual({
      Bucket: "uploads",
      Key: key,
    });
    expect(() => resolveS3Location(`incoming/${key}`, "archive")).toThrow(
      "Bucket d’upload",
    );
    expect(() =>
      resolveS3Location("incoming/../secret", "archive", "uploads"),
    ).toThrow("Clé de stockage");
  });
  it("ralentit la lecture distante lorsque le consommateur est en pause", async () => {
    const store = new S3FileStore("catalogues", {
      endpoint: "https://s3.example.test",
      region: "eu-central-003",
      accessKeyId: "test",
      secretAccessKey: "test",
    });
    let pulled = 0;
    Object.defineProperty(store, "client", {
      value: {
        send: async () => ({
          Body: Readable.from(
            (async function* () {
              for (let index = 0; index < 256; index++) {
                pulled++;
                yield Buffer.alloc(64 * 1024);
              }
            })(),
          ),
        }),
      },
    });
    const stream = store.read(`${randomUUID()}/${randomUUID()}`);
    const iterator = stream[Symbol.asyncIterator]();
    try {
      expect((await iterator.next()).value).toHaveLength(64 * 1024);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pulled).toBeLessThan(64);
    } finally {
      await iterator.return?.();
    }
  });
});
