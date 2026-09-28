import { afterEach, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import yazl from "yazl";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalFileStore } from "../../src/server/storage";
import { inspectSource } from "../../src/server/source";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function inspect(bytes: Buffer, filename: string) {
  const dir = await mkdtemp(join(tmpdir(), "catalog-formats-"));
  dirs.push(dir);
  const store = new LocalFileStore(dir);
  const saved = await store.put(
    randomUUID(),
    new Blob([bytes as BlobPart]).stream(),
  );
  return inspectSource(store, saved.key, filename);
}
function workbook() {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Référence", "Désignation", "Prix"],
    [123, "Pièce", 2],
  ]);
  sheet.A2.z = "00000";
  sheet.C2.f = "1+1";
  // BIFF8 formula tokens: two integers followed by addition, with length prefix.
  sheet.C2.bf = Buffer.from([7, 0, 0x1e, 1, 0, 0x1e, 1, 0, 0x03]);
  XLSX.utils.book_append_sheet(book, sheet, "Catalogue");
  return book;
}
async function ods(
  content: string,
  extras: { name: string; body: string }[] = [],
) {
  const zip = new yazl.ZipFile();
  zip.addBuffer(
    Buffer.from("application/vnd.oasis.opendocument.spreadsheet"),
    "mimetype",
    { compress: false },
  );
  zip.addBuffer(Buffer.from(content), "content.xml");
  for (const file of extras) zip.addBuffer(Buffer.from(file.body), file.name);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
const wrap = (rows: string) =>
  `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet><table:table table:name="Catalogue">${rows}</table:table></office:spreadsheet></office:body></office:document-content>`;
const header =
  "<table:table-row><table:table-cell><text:p>Référence</text:p></table:table-cell><table:table-cell><text:p>Désignation</text:p></table:table-cell></table:table-row>";
describe("formats de catalogues fournisseurs", () => {
  it("lit un vrai XLS BIFF8 et préserve les codes formatés et les formules", async () => {
    const bytes = XLSX.write(workbook(), { bookType: "biff8", type: "buffer" });
    expect(bytes.subarray(0, 8).toString("hex")).toBe("d0cf11e0a1b11ae1");
    const result = await inspect(bytes, "ancien.xls");
    expect(result.format).toBe("xls");
    expect(result.sheet).toBe("Catalogue");
    expect(result.rowCount).toBe(1);
    expect(result.preview[0].values).toEqual(["00123", "Pièce", "=1+1"]);
  });
  it("lit un vrai ODS exporté par une bibliothèque indépendante", async () => {
    const bytes = XLSX.write(workbook(), { bookType: "ods", type: "buffer" });
    const result = await inspect(bytes, "libreoffice.ods");
    expect(result.format).toBe("ods");
    expect(result.headers).toEqual(["Référence", "Désignation", "Prix"]);
    expect(result.preview[0].values[1]).toBe("Pièce");
    expect(result.preview[0].values[2]).toBe("=1+1");
  });
  it("préserve les espaces, paragraphes, codes et formules ODS sans exécution", async () => {
    const row =
      '<table:table-row><table:table-cell office:value-type="float" office:value="123"><text:p>00123</text:p></table:table-cell><table:table-cell><text:p>Pièce<text:s text:c="2"/>A</text:p><text:p>Suite<text:tab/>B</text:p></table:table-cell><table:table-cell table:formula="of:=1+1" office:value="2"/><table:table-cell table:number-columns-repeated="1024"/></table:table-row>';
    const result = await inspect(await ods(wrap(header + row)), "texte.ods");
    expect(result.preview[0].values).toEqual([
      "00123",
      "Pièce  A\nSuite\tB",
      "=1+1",
    ]);
  });
  it("borne aussi les lignes répétées ODS à 500 000", async () => {
    const row = (count: number) =>
      `<table:table-row table:number-rows-repeated="${count}"><table:table-cell><text:p>001</text:p></table:table-cell><table:table-cell><text:p>Pièce</text:p></table:table-cell></table:table-row>`;
    const result = await inspect(
      await ods(wrap(header + row(500_000))),
      "grand.ods",
    );
    expect(result.rowCount).toBe(500_000);
    expect(result.preview).toHaveLength(20);
    await expect(
      inspect(await ods(wrap(header + row(500_001))), "trop.ods"),
    ).rejects.toThrow("lignes par feuille");
  }, 30_000);
  it("refuse les DTD, macros et contenus trompeurs ODS", async () => {
    await expect(
      inspect(
        await ods('<!DOCTYPE x [<!ENTITY e "danger">]>' + wrap(header)),
        "dtd.ods",
      ),
    ).rejects.toThrow("DTD");
    await expect(
      inspect(
        await ods(wrap(header), [
          { name: "Basic/Standard/script.xml", body: "macro" },
        ]),
        "macro.ods",
      ),
    ).rejects.toThrow("Classeur refusé");
    await expect(
      inspect(Buffer.from("sku;nom\n1;Pièce\n"), "faux.ods"),
    ).rejects.toThrow();
  });
  it("accepte TXT délimité et refuse un texte libre sans structure", async () => {
    const result = await inspect(
      Buffer.from("ref|nom\n01|Pièce\n".replaceAll("|", "\t")),
      "catalogue.txt",
    );
    expect(result.rowCount).toBe(1);
    expect(result.delimiter).toBe("\t");
    await expect(
      inspect(Buffer.from("un paragraphe de texte libre"), "note.txt"),
    ).rejects.toThrow();
  });
});
