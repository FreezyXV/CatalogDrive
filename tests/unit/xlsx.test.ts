import { afterEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { type FileStore, LocalFileStore } from "../../src/server/storage";
import { inspectSource } from "../../src/server/source";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
describe("lecture XLSX réelle", () => {
  it("détecte les feuilles, l’en-tête, les codes à zéro et conserve les formules sans les exécuter", async () => {
    const workbook = new ExcelJS.Workbook();
    const intro = workbook.addWorksheet("Introduction");
    intro.addRow(["Notice"]);
    const sheet = workbook.addWorksheet("Catalogue");
    sheet.addRow(["Export fournisseur"]);
    sheet.addRow(["Référence", "Désignation", "Prix"]);
    const row = sheet.addRow([123, "Filtre", { formula: "1+1", result: 2 }]);
    row.getCell(1).numFmt = "00000";
    const bytes = await workbook.xlsx.writeBuffer();
    const dir = await mkdtemp(join(tmpdir(), "xlsx-test-"));
    dirs.push(dir);
    const store = new LocalFileStore(dir);
    const saved = await store.put(
      randomUUID(),
      new Blob([bytes as BlobPart]).stream(),
    );
    const diagnostic = await inspectSource(store, saved.key, "catalogue.xlsx");
    expect(diagnostic.sheets).toEqual(["Introduction", "Catalogue"]);
    expect(diagnostic.sheet).toBe("Catalogue");
    expect(diagnostic.headerLine).toBe(2);
    expect(diagnostic.headers).toEqual(["Référence", "Désignation", "Prix"]);
    expect(diagnostic.preview[0].values).toEqual(["00123", "Filtre", "=1+1"]);
    expect(diagnostic.columnTypes?.[0]).toBe("texte / code");
    const consumed: string[][] = [];
    await inspectSource(
      store,
      saved.key,
      "catalogue.xlsx",
      { sheet: "Catalogue" },
      async (record) => {
        consumed.push(record.values);
      },
    );
    expect(consumed).toEqual([["00123", "Filtre", "=1+1"]]);
    const renamed = await inspectSource(store, saved.key, "catalogue.xls");
    expect(renamed.format).toBe("xlsx");
    expect(renamed.preview[0].values).toEqual(diagnostic.preview[0].values);
  });
  it("refuse un ancien XLS binaire incomplet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xls-test-"));
    dirs.push(dir);
    const store = new LocalFileStore(dir);
    const saved = await store.put(
      randomUUID(),
      new Blob([Buffer.from("d0cf11e0a1b11ae1", "hex")]).stream(),
    );
    await expect(inspectSource(store, saved.key, "ancien.xls")).rejects.toThrow(
      "Lecture du classeur impossible",
    );
  });
  it("analyse un TSV avec le même pipeline que le CSV", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsv-test-"));
    dirs.push(dir);
    const store = new LocalFileStore(dir);
    const saved = await store.put(
      randomUUID(),
      new Blob(["ref\tnom\n001\tPièce\n"]).stream(),
    );
    const diagnostic = await inspectSource(store, saved.key, "catalogue.tsv");
    expect(diagnostic.format).toBe("csv");
    expect(diagnostic.delimiter).toBe("\t");
    expect(diagnostic.rowCount).toBe(1);
  });
});

async function largeWorkbook(path: string, count: number) {
  const zip = new yazl.ZipFile();
  // Deliberately put the worksheet before workbook metadata, as some suppliers do.
  async function* xml() {
    yield '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Référence</t></is></c><c r="B1" t="inlineStr"><is><t>Désignation</t></is></c></row>';
    for (let index = 2; index <= count + 1; index++)
      yield `<row r="${index}"><c r="A${index}"><v>${index}</v></c><c r="B${index}" t="inlineStr"><is><t>Pièce</t></is></c></row>`;
    yield "</sheetData></worksheet>";
  }
  zip.addReadStream(Readable.from(xml()), "xl/worksheets/sheet1.xml");
  zip.addBuffer(
    Buffer.from(
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Catalogue" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    "xl/workbook.xml",
  );
  zip.addBuffer(
    Buffer.from(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>',
    ),
    "xl/_rels/workbook.xml.rels",
  );
  zip.addBuffer(
    Buffer.from(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ),
    "[Content_Types].xml",
  );
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(path));
}
it("lit 500 000 lignes Excel en flux, même avec les métadonnées après la feuille, et refuse la suivante", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xlsx-large-test-"));
  dirs.push(dir);
  const path = join(dir, "source.xlsx");
  const key = "source";
  const source = { read: () => createReadStream(path) } as unknown as FileStore;
  await largeWorkbook(path, 500_000);
  let consumed = 0;
  let lastLine = 0;
  const diagnostic = await inspectSource(
    source,
    key,
    "grand.xlsx",
    { sheet: "Catalogue" },
    async (row) => {
      consumed++;
      lastLine = row.line;
    },
  );
  expect(diagnostic.rowCount).toBe(500_000);
  expect(diagnostic.preview).toHaveLength(20);
  expect(diagnostic.sheet).toBe("Catalogue");
  expect(consumed).toBe(500_000);
  expect(lastLine).toBe(500_001);
  await largeWorkbook(path, 500_001);
  await expect(inspectSource(source, key, "trop-grand.xlsx")).rejects.toThrow(
    "lignes par feuille",
  );
}, 90_000);
