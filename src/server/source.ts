import ExcelJS from "exceljs";
import yauzl from "yauzl";
import { mkdtemp, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  analyzeCsv,
  detectFormat,
  LIMITS,
  ImportError,
  type Diagnostic,
} from "@/domain/csv";
import { suggestMapping, type ReadOptions } from "@/domain/catalog";
import type { FileStore } from "./storage";

export type SourceRow = { line: number; values: string[] };
export function inferTypes(preview: SourceRow[], headers: string[]) {
  return headers.map((_, index) => {
    const values = preview.map((row) => row.values[index]).filter(Boolean);
    if (!values.length) return "vide";
    if (values.some((value) => /^0\d/.test(value))) return "texte / code";
    if (values.every((value) => /^-?\d+$/.test(value)))
      return "entier probable";
    if (values.every((value) => /^-?\d+[.,]\d{1,2}$/.test(value)))
      return "décimal probable";
    return "texte";
  });
}
export async function preflightXlsx(path: string) {
  await new Promise<void>((resolve, reject) =>
    yauzl.open(
      path,
      { lazyEntries: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) {
          reject(new ImportError("Classeur XLSX invalide ou chiffré."));
          return;
        }
        let total = 0,
          entries = 0,
          hasWorkbook = false;
        const fail = () => {
          zip.close();
          reject(
            new ImportError(
              "Classeur refusé : archive trop volumineuse, chiffrée, active ou contenant des liens externes.",
            ),
          );
        };
        zip.on("error", fail);
        zip.on("entry", (entry: yauzl.Entry) => {
          total += entry.uncompressedSize;
          entries++;
          if (entry.fileName === "xl/workbook.xml") hasWorkbook = true;
          if (
            entries > 1000 ||
            total > 64 * 1024 * 1024 ||
            entry.uncompressedSize > 32 * 1024 * 1024 ||
            entry.generalPurposeBitFlag & 1 ||
            /(?:^|\/)\.\.(?:\/|$)|vbaProject|externalLinks|embeddings/i.test(
              entry.fileName,
            ) ||
            entry.uncompressedSize / Math.max(1, entry.compressedSize) > 1000
          ) {
            fail();
            return;
          }
          if (entry.fileName.endsWith("/")) {
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (error, stream) => {
            if (error || !stream) {
              fail();
              return;
            }
            let bytes = 0;
            stream.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > entry.uncompressedSize || bytes > 32 * 1024 * 1024) {
                stream.destroy();
                fail();
              }
            });
            stream.on("error", fail);
            stream.on("end", () => zip.readEntry());
          });
        });
        zip.on("end", () => {
          if (!hasWorkbook)
            reject(
              new ImportError("L’archive ne contient pas de classeur XLSX."),
            );
          else resolve();
        });
        zip.readEntry();
      },
    ),
  );
}
function cellText(cell: ExcelJS.Cell) {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "formula" in value)
    return `=${value.formula}`;
  if (typeof value === "object" && "sharedFormula" in value)
    return `=FORMULE_PARTAGEE(${value.sharedFormula})`;
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    /^0{2,20}$/.test(cell.numFmt ?? "")
  )
    return String(value).padStart(cell.numFmt.length, "0");
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && "richText" in value)
    return value.richText.map((part) => part.text).join("");
  if (typeof value === "object" && "hyperlink" in value) return value.text;
  if (typeof value === "object" && "error" in value) return value.error;
  return String(value);
}
export async function inspectSource(
  store: FileStore,
  key: string,
  filename: string,
  options: ReadOptions = {},
  onRow?: (row: SourceRow, headers: string[]) => Promise<void>,
): Promise<Diagnostic> {
  if (/\.csv$/i.test(filename)) {
    const sample = await store.sample(key);
    const selected: ReadOptions = { ...options };
    if (!selected.headerLine) {
      let encoding: "utf-8" | "utf-16le" | "windows-1252" =
        selected.encoding ?? "utf-8";
      if (!selected.encoding) {
        if (sample[0] === 0xff && sample[1] === 0xfe) encoding = "utf-16le";
        else {
          try {
            new TextDecoder("utf-8", { fatal: true }).decode(sample, {
              stream: true,
            });
          } catch {
            encoding = "windows-1252";
          }
        }
      }
      const lines = new TextDecoder(encoding)
        .decode(sample, { stream: true })
        .split(/\r\n|\n|\r/)
        .slice(0, 30);
      let best = 0;
      lines.forEach((line, index) => {
        for (const separator of selected.delimiter
          ? [selected.delimiter]
          : ([";", ",", "\t"] as const)) {
          const count = Object.keys(
            suggestMapping(line.split(separator)),
          ).length;
          if (count > best && count >= 2) {
            best = count;
            selected.headerLine = index + 1;
            selected.delimiter = separator;
          }
        }
      });
      if (selected.headerLine && selected.headerLine > 1)
        selected.encoding = encoding;
    }
    // The diagnostic from the original detector retains its uncertainty note.
    if (selected.headerLine && selected.headerLine > 1 && !selected.encoding)
      selected.encoding = detectFormat(sample).encoding;
    const result = await analyzeCsv(store.read(key), sample, selected, onRow);
    result.columnTypes = inferTypes(result.preview, result.headers);
    return result;
  }
  if (!/\.xlsx$/i.test(filename))
    throw new ImportError("Formats acceptés : CSV ou XLSX.");
  const dir = await mkdtemp(join(tmpdir(), "catamotive-xlsx-"));
  const path = join(dir, "source.xlsx");
  try {
    await pipeline(store.read(key), createWriteStream(path, { mode: 0o600 }));
    await preflightXlsx(path);
    // ExcelJS' streaming reader cannot read valid archives whose workbook.xml
    // entry appears after worksheets (including files produced by ExcelJS).
    // The preflight caps uncompressed data at 64 MiB, so the bounded document
    // reader is safer and interoperable while rows are still emitted in batches.
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path);
    if (workbook.worksheets.length > 20)
      throw new ImportError("Un classeur est limité à 20 feuilles.");
    const diagnostics: Diagnostic[] = [];
    for (const sheet of workbook.worksheets) {
      const name = sheet.name || `Feuille ${diagnostics.length + 1}`;
      const d: Diagnostic = {
        format: "xlsx",
        encoding: "utf-8",
        encodingNote: "Texte Unicode du classeur XLSX",
        delimiter: "",
        sheet: name,
        headers: [],
        rowCount: 0,
        irregularRowCount: 0,
        warnings: [],
        preview: [],
      };
      const candidates: SourceRow[] = [];
      const selected = options.sheet
        ? name === options.sheet
        : diagnostics.length === 0;
      let headerLine = options.headerLine;
      const consume = async (record: SourceRow) => {
        if (!d.headers.length) {
          d.headers = record.values;
          d.headerLine = record.line;
          return;
        }
        d.rowCount++;
        if (d.rowCount > LIMITS.rows)
          throw new ImportError(
            "Le classeur dépasse 50 000 lignes par feuille.",
          );
        while (record.values.length < d.headers.length) record.values.push("");
        if (record.values.length > d.headers.length) d.irregularRowCount++;
        if (d.preview.length < LIMITS.preview) d.preview.push(record);
        if (selected && onRow) await onRow(record, d.headers);
      };
      const flushCandidates = async () => {
        if (!headerLine)
          headerLine = [...candidates].sort(
            (a, b) =>
              Object.keys(suggestMapping(b.values)).length -
              Object.keys(suggestMapping(a.values)).length,
          )[0]?.line;
        for (const record of candidates)
          if (record.line >= (headerLine ?? 1)) await consume(record);
        candidates.length = 0;
      };
      for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
        const row = sheet.getRow(rowNumber);
        if (row.cellCount > LIMITS.columns || row.number > 100_000)
          throw new ImportError(
            "Le classeur dépasse les limites de lignes ou de colonnes.",
          );
        const values = Array.from({ length: row.cellCount }, (_, i) =>
          cellText(row.getCell(i + 1)),
        );
        if (values.join("").length > LIMITS.recordSize)
          throw new ImportError("Une ligne XLSX dépasse 64 K caractères.");
        if (values.every((value) => value === "")) continue;
        const record = { line: row.number, values };
        if (!d.headers.length) {
          if (headerLine) {
            if (record.line >= headerLine) await consume(record);
          } else {
            candidates.push(record);
            if (candidates.length >= 20) await flushCandidates();
          }
        } else await consume(record);
      }
      if (candidates.length) await flushCandidates();
      if (d.headers.some((header) => !header.trim()))
        d.warnings.push(
          "Des en-têtes sont vides ; les positions sont conservées.",
        );
      if (new Set(d.headers).size !== d.headers.length)
        d.warnings.push(
          "Des en-têtes sont dupliqués ; les colonnes sont distinctes.",
        );
      if (d.irregularRowCount)
        d.warnings.push(
          `${d.irregularRowCount} ligne(s) comportent des colonnes supplémentaires.`,
        );
      d.columnTypes = inferTypes(d.preview, d.headers);
      diagnostics.push(d);
    }
    const result = options.sheet
      ? diagnostics.find((d) => d.sheet === options.sheet)
      : [...diagnostics]
          .filter((d) => d.rowCount > 0)
          .sort(
            (a, b) =>
              Object.keys(suggestMapping(b.headers)).length -
                Object.keys(suggestMapping(a.headers)).length ||
              b.rowCount - a.rowCount,
          )[0];
    if (!result || !result.rowCount)
      throw new ImportError("La feuille choisie est vide ou introuvable.");
    return { ...result, sheets: diagnostics.map((d) => d.sheet!) };
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError(
      `Lecture XLSX impossible. Vérifiez que le classeur est valide et non chiffré.${error instanceof Error ? ` Détail : ${error.message}` : ""}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
