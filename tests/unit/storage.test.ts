import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { LocalFileStore, resolveS3Location } from "../../src/server/storage";
import { LIMITS } from "../../src/domain/csv";
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
    let count = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (count++ < 6) controller.enqueue(new Uint8Array(1024 * 1024));
        else controller.close();
      },
    });
    await expect(store.put(org, body)).rejects.toThrow("5 Mio");
    expect(await readdir(join(dir, org))).toEqual([]);
  });
  it("refuse le fichier vide et les clés de traversée", async () => {
    const { store, org } = await storage();
    await expect(store.put(org, new Blob([]).stream())).rejects.toThrow("vide");
    expect(() => store.read("../../secret")).toThrow("Clé");
    expect(LIMITS.bytes).toBe(5 * 1024 * 1024);
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
});
