import { afterEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { LocalFileStore } from "../../src/server/storage";
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
  });
});
