import { readFile, stat } from "node:fs/promises";
import * as XLSX from "xlsx";
import yauzl from "yauzl";
import { SaxesParser } from "saxes";
import { ImportError, LIMITS } from "@/domain/csv";
import type { SourceRow } from "./source";

export type SpreadsheetSheet = { name: string; rows: AsyncIterable<SourceRow> };
export async function* legacyXlsSheets(
  path: string,
): AsyncGenerator<SpreadsheetSheet> {
  // BIFF is a legacy in-memory parser. Keep its input bounded independently of
  // the streaming CSV/XLSX/ODS allowance and never evaluate formulas or macros.
  if ((await stat(path)).size > 16 * 1024 * 1024)
    throw new ImportError(
      "Un ancien XLS binaire est limité à 16 Mio. Convertissez-le en XLSX, ODS ou CSV pour les gros catalogues.",
    );
  const workbook = XLSX.read(await readFile(path), {
    type: "buffer",
    dense: true,
    cellFormula: true,
    cellText: true,
    cellHTML: false,
    bookVBA: true,
    sheetRows: LIMITS.rows + 2,
  });
  if (workbook.vbaraw)
    throw new ImportError("Les macros dans les anciens XLS sont refusées.");
  if (!workbook.SheetNames.length || workbook.SheetNames.length > 20)
    throw new ImportError("Un classeur doit contenir entre 1 et 20 feuilles.");
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    async function* rows() {
      if (!sheet["!ref"]) return;
      const range = XLSX.utils.decode_range(sheet["!ref"]);
      const dense = sheet["!data"] as XLSX.CellObject[][];
      if (range.e.r > LIMITS.rows + 1000 || range.e.c >= LIMITS.columns)
        throw new ImportError(
          "Le XLS dépasse les limites de lignes ou de colonnes.",
        );
      for (let r = range.s.r; r <= range.e.r; r++) {
        const cells = dense?.[r] ?? [];
        const values = Array.from({ length: range.e.c + 1 }, (_, c) => {
          const cell = cells[c];
          if (!cell) return "";
          if (cell.f) return `=${cell.f}`;
          return cell.w ?? String(cell.v ?? "");
        });
        yield { line: r + 1, values };
      }
    }
    yield { name, rows: rows() };
  }
}
const TABLE = "urn:oasis:names:tc:opendocument:xmlns:table:1.0";
const TEXT = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
const OFFICE = "urn:oasis:names:tc:opendocument:xmlns:office:1.0";
type OdsEvent =
  | { kind: "sheet"; name: string }
  | { kind: "end" }
  | { kind: "row"; values: string[]; repeat: number };
const repeatCount = (value?: string) => {
  const count = Number(value ?? 1);
  if (!Number.isSafeInteger(count) || count < 1 || count > 1_048_576)
    throw new ImportError(
      "Une répétition de lignes ou de cellules ODS est invalide.",
    );
  return count;
};
export async function* odsSheets(
  path: string,
  entries: yauzl.Entry[],
): AsyncGenerator<SpreadsheetSheet> {
  const zip = await yauzl.openPromise(path, { autoClose: false });
  let stream: import("node:stream").Readable | undefined;
  try {
    const mime = entries.find((entry) => entry.fileName === "mimetype");
    if (!mime || mime.uncompressedSize > 100)
      throw new ImportError("Le fichier n’est pas un classeur ODS.");
    const mimeStream = await zip.openReadStreamPromise(mime);
    const chunks: Buffer[] = [];
    for await (const chunk of mimeStream) chunks.push(Buffer.from(chunk));
    if (
      Buffer.concat(chunks).toString() !==
      "application/vnd.oasis.opendocument.spreadsheet"
    )
      throw new ImportError("Le fichier n’est pas un classeur ODS.");
    const content = entries.find((entry) => entry.fileName === "content.xml");
    if (!content)
      throw new ImportError("Le classeur ODS ne contient pas de données.");
    stream = await zip.openReadStreamPromise(content);
    const parser = new SaxesParser({ xmlns: true });
    const queue: OdsEvent[] = [];
    let values: string[] = [],
      column = 0,
      rowRepeat = 1,
      cellRepeat = 1;
    let text = "",
      fallback = "",
      formula = "",
      inCell = false,
      paragraphs = 0,
      paragraphDepth = 0,
      tables = 0;
    parser.on("doctype", () => {
      throw new ImportError("Les déclarations DTD dans un ODS sont refusées.");
    });
    parser.on("opentag", (tag) => {
      if (tag.uri === OFFICE && ["script", "scripts"].includes(tag.local))
        throw new ImportError("Les scripts et macros ODS sont refusés.");
      const attr = (uri: string, local: string) =>
        Object.values(tag.attributes).find(
          (a) => a.uri === uri && a.local === local,
        )?.value;
      if (tag.uri === TABLE && tag.local === "table") {
        tables++;
        if (tables > 20)
          throw new ImportError("Un classeur est limité à 20 feuilles.");
        queue.push({
          kind: "sheet",
          name: attr(TABLE, "name") || `Feuille ${tables}`,
        });
      } else if (tag.uri === TABLE && tag.local === "table-row") {
        values = [];
        column = 0;
        rowRepeat = repeatCount(attr(TABLE, "number-rows-repeated"));
      } else if (
        tag.uri === TABLE &&
        ["table-cell", "covered-table-cell"].includes(tag.local)
      ) {
        cellRepeat = repeatCount(attr(TABLE, "number-columns-repeated"));
        text = "";
        paragraphs = 0;
        paragraphDepth = 0;
        inCell = true;
        fallback =
          attr(OFFICE, "string-value") ??
          attr(OFFICE, "date-value") ??
          attr(OFFICE, "boolean-value") ??
          attr(OFFICE, "value") ??
          "";
        formula = attr(TABLE, "formula") ?? "";
      } else if (inCell && tag.uri === TEXT && tag.local === "p") {
        if (paragraphs++) text += "\n";
        paragraphDepth++;
      } else if (inCell && tag.uri === TEXT && tag.local === "s") {
        const count = repeatCount(attr(TEXT, "c"));
        if (count > LIMITS.recordSize)
          throw new ImportError("Une cellule ODS dépasse 64 K caractères.");
        text += " ".repeat(count);
      } else if (inCell && tag.uri === TEXT && tag.local === "tab")
        text += "\t";
      else if (inCell && tag.uri === TEXT && tag.local === "line-break")
        text += "\n";
      if (
        text.length > LIMITS.recordSize ||
        fallback.length > LIMITS.recordSize ||
        formula.length > LIMITS.recordSize
      )
        throw new ImportError("Une cellule ODS dépasse 64 K caractères.");
    });
    const appendText = (value: string) => {
      if (inCell && paragraphDepth) {
        text += value;
        if (text.length > LIMITS.recordSize)
          throw new ImportError("Une cellule ODS dépasse 64 K caractères.");
      }
    };
    parser.on("text", appendText);
    parser.on("cdata", appendText);
    parser.on("closetag", (tag) => {
      if (tag.uri === TEXT && tag.local === "p") paragraphDepth--;
      if (tag.uri !== TABLE) return;
      if (["table-cell", "covered-table-cell"].includes(tag.local)) {
        const value = formula
          ? `=${formula.replace(/^[^:]*:=?/, "").replace(/^=/, "")}`
          : paragraphs
            ? text
            : fallback;
        if (value && column + cellRepeat > LIMITS.columns)
          throw new ImportError(
            `Le classeur dépasse ${LIMITS.columns} colonnes.`,
          );
        for (let c = 0; c < Math.min(cellRepeat, LIMITS.columns - column); c++)
          values.push(value);
        column += cellRepeat;
        inCell = false;
      } else if (tag.local === "table-row") {
        while (values.length && values.at(-1) === "") values.pop();
        queue.push({ kind: "row", values, repeat: rowRepeat });
      } else if (tag.local === "table") queue.push({ kind: "end" });
    });
    async function* events() {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      for await (const chunk of stream!) {
        parser.write(decoder.decode(chunk as Uint8Array, { stream: true }));
        yield* queue.splice(0);
      }
      parser.write(decoder.decode()).close();
      yield* queue.splice(0);
    }
    const iterator = events()[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        if (next.value.kind !== "sheet")
          throw new ImportError("La structure du classeur ODS est invalide.");
        const name = next.value.name;
        async function* rows() {
          let line = 1;
          while (true) {
            const next = await iterator.next();
            if (next.done)
              throw new ImportError("La feuille ODS est incomplète.");
            if (next.value.kind === "end") return;
            if (next.value.kind !== "row")
              throw new ImportError(
                "Les feuilles ODS imbriquées sont refusées.",
              );
            const { values, repeat } = next.value;
            if (line + repeat > 1_048_577)
              throw new ImportError(
                "La feuille ODS dépasse sa limite de lignes physiques.",
              );
            if (values.some(Boolean))
              for (let r = 0; r < repeat; r++)
                yield { line: line + r, values: [...values] };
            line += repeat;
          }
        }
        yield { name, rows: rows() };
      }
    } finally {
      await iterator.return?.();
    }
  } finally {
    stream?.destroy();
    zip.close();
  }
}
