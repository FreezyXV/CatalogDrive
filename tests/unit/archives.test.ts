import { afterEach, describe, expect, it } from "vitest";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import {
  forEachCatalogArchiveEntry,
  PILOT_ARCHIVE_LIMITS,
} from "../../src/server/archives";

const dirs: string[] = [];
async function archive(files: { name: string; body: Buffer }[]) {
  const dir = await mkdtemp(join(tmpdir(), "catamotive-zip-"));
  dirs.push(dir);
  const path = join(dir, "source.zip");
  const zip = new yazl.ZipFile();
  for (const file of files) zip.addBuffer(file.body, file.name);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(path));
  return path;
}
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("lecture des archives fournisseurs", () => {
  it("extrait plusieurs CSV en flux, avec leurs noms et octets exacts", async () => {
    const first = Buffer.from("ref;nom\n001;Pièce A\n");
    const second = Buffer.from("sku,nom\n002,Pièce B\n");
    const path = await archive([
      { name: "fournisseur-a/catalogue.csv", body: first },
      { name: "fournisseur-b/catalogue.csv", body: second },
    ]);
    const seen: { name: string; filename: string; body: Buffer }[] = [];
    const result = await forEachCatalogArchiveEntry(
      path,
      PILOT_ARCHIVE_LIMITS,
      async (entry, source) => {
        const chunks: Buffer[] = [];
        for await (const chunk of source) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        seen.push({ name: entry.name, filename: entry.filename, body });
        return body.length;
      },
    );
    expect(result).toEqual({
      entries: 2,
      totalBytes: first.length + second.length,
    });
    expect(seen).toEqual([
      {
        name: "fournisseur-a/catalogue.csv",
        filename: "catalogue.csv",
        body: first,
      },
      {
        name: "fournisseur-b/catalogue.csv",
        filename: "catalogue.csv",
        body: second,
      },
    ]);
  });

  it("refuse un contenu annexe et une expansion qui dépasse les bornes", async () => {
    const unsupported = await archive([
      { name: "catalogue.csv", body: Buffer.from("a;b\n1;2") },
      { name: "note.txt", body: Buffer.from("secret") },
    ]);
    await expect(
      forEachCatalogArchiveEntry(
        unsupported,
        PILOT_ARCHIVE_LIMITS,
        async (_, source) => {
          let count = 0;
          for await (const chunk of source) count += chunk.length;
          return count;
        },
      ),
    ).rejects.toThrow("note.txt");

    const oversized = await archive([
      { name: "catalogue.csv", body: Buffer.alloc(1024 * 1024, 65) },
    ]);
    await expect(
      forEachCatalogArchiveEntry(
        oversized,
        { entries: 2, entryBytes: 512 * 1024, totalBytes: 2 * 1024 * 1024 },
        async () => 0,
      ),
    ).rejects.toThrow("limite par fichier");
  });
});
