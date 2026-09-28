import ExcelJS from "exceljs";
import yauzl from "yauzl";
import yazl from "yazl";
import { mkdtemp, open, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import {
  analyzeCsv,
  detectFormat,
  LIMITS,
  ImportError,
  type Diagnostic,
} from "@/domain/csv";
import { suggestMapping, type ReadOptions } from "@/domain/catalog";
import type { FileStore } from "./storage";
import { legacyXlsSheets, odsSheets } from "./spreadsheet-readers";

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
// Inspect every decompressed byte before giving XML to the Excel reader.
// The original remains unchanged; only a temporary reader copy is reordered.
export async function preflightXlsx(
  path: string,
  format: "xlsx" | "ods" = "xlsx",
) {
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(path, {
      lazyEntries: true,
      autoClose: false,
      validateEntrySizes: true,
      strictFileNames: true,
    });
  } catch {
    throw new ImportError("Classeur XLSX invalide ou chiffré.");
  }
  const entries: yauzl.Entry[] = [];
  const names = new Set<string>();
  let total = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      total += entry.uncompressedSize;
      if (
        entries.length >= 1000 ||
        names.has(entry.fileName) ||
        total > 256 * 1024 * 1024 ||
        entry.uncompressedSize > 192 * 1024 * 1024 ||
        (!/^(xl\/worksheets\/sheet\d+\.xml|content\.xml)$/.test(
          entry.fileName,
        ) &&
          entry.uncompressedSize > 32 * 1024 * 1024) ||
        entry.generalPurposeBitFlag & 1 ||
        /(?:^|\/)\.\.(?:\/|$)|vbaProject|externalLinks|embeddings|(?:^|\/)Scripts|(?:^|\/)Basic|(?:^|\/)Object/i.test(
          entry.fileName,
        ) ||
        entry.uncompressedSize / Math.max(1, entry.compressedSize) > 1000
      )
        throw new ImportError(
          "Classeur refusé : archive trop volumineuse, chiffrée, active ou contenant des liens externes.",
        );
      names.add(entry.fileName);
      entries.push(entry);
      if (entry.fileName.endsWith("/")) continue;
      const stream = await zip.openReadStreamPromise(entry);
      let bytes = 0;
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > entry.uncompressedSize)
          throw new ImportError("La taille d’une entrée XLSX est incohérente.");
      }
      if (bytes !== entry.uncompressedSize)
        throw new ImportError("La taille d’une entrée XLSX est incohérente.");
    }
    if (format === "ods") {
      if (!names.has("content.xml") || !names.has("mimetype"))
        throw new ImportError("Le fichier n’est pas un classeur ODS.");
      return entries;
    }
    if (
      !names.has("xl/workbook.xml") ||
      !names.has("xl/_rels/workbook.xml.rels")
    )
      throw new ImportError("L’archive ne contient pas de classeur XLSX.");
    const sheets = entries.filter((entry) =>
      /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.fileName),
    );
    if (!sheets.length || sheets.length > 20)
      throw new ImportError(
        "Un classeur doit contenir entre 1 et 20 feuilles.",
      );
    return entries;
  } finally {
    zip.close();
  }
}
async function prepareXlsx(path: string, outputPath: string) {
  const entries = await preflightXlsx(path);
  const zip = await yauzl.openPromise(path, { autoClose: false });
  const output = new yazl.ZipFile();
  const outputStream = output.outputStream as Readable;
  let active: Readable | undefined;
  output.on("error", (error) => outputStream.destroy(error));
  try {
    // ExcelJS requires workbook metadata, styles and shared strings before cells.
    // Reordering removes its dependency on the supplier's ZIP entry order and
    // avoids materializing the entire workbook or its deferred worksheet files.
    const metadata = [
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/sharedStrings.xml",
    ];
    let outputAddedStrings = false;
    const ordered = [
      ...metadata.flatMap((name) =>
        entries.filter((entry) => entry.fileName === name),
      ),
      ...entries.filter((entry) =>
        /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.fileName),
      ),
    ];
    for (const entry of ordered) {
      if (entry.fileName === "xl/_rels/workbook.xml.rels") {
        const stream = await zip.openReadStreamPromise(entry);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        const xml = Buffer.concat(chunks).toString("utf8");
        if (/TargetMode\s*=\s*["']External["']|<!DOCTYPE/i.test(xml))
          throw new ImportError(
            "Les relations externes du classeur sont refusées.",
          );
        output.addBuffer(
          Buffer.from(
            xml.replace(
              /Target=(["'])\/?xl\/(worksheets\/sheet\d+\.xml)\1/g,
              "Target=$1$2$1",
            ),
          ),
          entry.fileName,
          { compress: false },
        );
        continue;
      }
      // Workbooks with inline strings still need an empty string cache so the
      // streaming reader does not spool every worksheet to an unmanaged file.
      if (
        /^xl\/worksheets\//.test(entry.fileName) &&
        !entries.some((e) => e.fileName === "xl/sharedStrings.xml") &&
        !outputAddedStrings
      ) {
        output.addBuffer(
          Buffer.from(
            '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>',
          ),
          "xl/sharedStrings.xml",
          { compress: false },
        );
        outputAddedStrings = true;
      }
      output.addReadStreamLazy(
        entry.fileName,
        { compress: false, size: entry.uncompressedSize },
        (callback) => {
          zip.openReadStream(entry, (error, stream) => {
            if (stream) active = stream;
            callback(error, stream);
          });
        },
      );
    }
    output.end();
    await pipeline(
      outputStream,
      createWriteStream(outputPath, { mode: 0o600 }),
    );
  } finally {
    active?.destroy();
    outputStream.destroy();
    zip.close();
  }
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
  if (/\.(csv|tsv|txt)$/i.test(filename)) {
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
  if (onRow && !options.sheet && /\.(xls|xlsx|ods)$/i.test(filename)) {
    const diagnostic = await inspectSource(store, key, filename, options);
    return inspectSource(
      store,
      key,
      filename,
      { ...options, sheet: diagnostic.sheet },
      onRow,
    );
  }
  if (!/\.(xls|xlsx|ods)$/i.test(filename))
    throw new ImportError(
      "Formats acceptés : CSV, TSV, TXT délimité, XLS, XLSX ou ODS.",
    );
  const dir = await mkdtemp(join(tmpdir(), "catamotive-xlsx-"));
  const path = join(dir, "source.xlsx");
  try {
    await pipeline(store.read(key), createWriteStream(path, { mode: 0o600 }));
    let format: "xlsx" | "xls" | "ods" = /\.ods$/i.test(filename)
      ? "ods"
      : "xlsx";
    if (/\.xls$/i.test(filename)) {
      const handle = await open(path, "r");
      const signature = Buffer.alloc(8);
      try {
        await handle.read(signature, 0, signature.length, 0);
      } finally {
        await handle.close();
      }
      if (signature.equals(Buffer.from("d0cf11e0a1b11ae1", "hex")))
        format = "xls";
    }
    const diagnostics: Diagnostic[] = [];
    const analyzeSheet = async (
      name: string,
      rows: AsyncIterable<SourceRow>,
    ) => {
      if (diagnostics.length >= 20)
        throw new ImportError("Un classeur est limité à 20 feuilles.");
      const d: Diagnostic = {
        format,
        encoding: "utf-8",
        encodingNote: `Texte Unicode du classeur ${format.toUpperCase()}`,
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
            `Le classeur dépasse ${LIMITS.rows.toLocaleString("fr-FR")} lignes par feuille.`,
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
      for await (const record of rows) {
        if (record.values.length > LIMITS.columns)
          throw new ImportError(
            `Le classeur dépasse ${LIMITS.columns} colonnes.`,
          );
        if (record.values.join("").length > LIMITS.recordSize)
          throw new ImportError(
            "Une ligne du classeur dépasse 64 K caractères.",
          );
        if (record.values.every((value) => value === "")) continue;
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
    };
    if (format === "xls") {
      for await (const sheet of legacyXlsSheets(path))
        await analyzeSheet(sheet.name, sheet.rows);
    } else if (format === "ods") {
      const entries = await preflightXlsx(path, "ods");
      for await (const sheet of odsSheets(path, entries))
        await analyzeSheet(sheet.name, sheet.rows);
    } else {
      const readerPath = join(dir, "reader.xlsx");
      await prepareXlsx(path, readerPath);
      const workbook = new ExcelJS.stream.xlsx.WorkbookReader(readerPath, {
        worksheets: "emit",
        sharedStrings: "cache",
        styles: "cache",
        hyperlinks: "ignore",
      });
      try {
        for await (const sheet of workbook) {
          const name =
            (sheet as unknown as { name?: string }).name ||
            `Feuille ${diagnostics.length + 1}`;
          async function* sourceRows() {
            for await (const row of sheet) {
              if (row.cellCount > LIMITS.columns)
                throw new ImportError(
                  `Le classeur dépasse ${LIMITS.columns} colonnes.`,
                );
              yield {
                line: row.number,
                values: Array.from({ length: row.cellCount }, (_, i) =>
                  cellText(row.getCell(i + 1)),
                ),
              };
            }
          }
          await analyzeSheet(name, sourceRows());
        }
      } finally {
        (workbook as unknown as { stream?: Readable }).stream?.destroy();
      }
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
      `Lecture du classeur impossible. Vérifiez que le classeur est valide et non chiffré.${error instanceof Error ? ` Détail : ${error.message}` : ""}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
