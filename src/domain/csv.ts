import { parse } from "csv-parse";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadOptions } from "./catalog";

export const LIMITS = {
  bytes: 5 * 1024 * 1024,
  rows: 50_000,
  columns: 200,
  recordSize: 65_536,
  preview: 20,
} as const;
export type Encoding = "utf-8" | "utf-16le" | "windows-1252";
export type Diagnostic = {
  format?: "csv" | "xlsx";
  headerLine?: number;
  sheets?: string[];
  sheet?: string;
  columnTypes?: string[];
  encoding: Encoding;
  encodingNote: string;
  delimiter: string;
  headers: string[];
  rowCount: number;
  irregularRowCount: number;
  warnings: string[];
  preview: { line: number; values: string[] }[];
};
export class ImportError extends Error {}

export function detectFormat(
  sample: Buffer,
): Pick<Diagnostic, "encoding" | "encodingNote" | "delimiter"> {
  if (!sample.length) throw new ImportError("Le fichier est vide.");
  if (sample[0] === 0x50 && sample[1] === 0x4b)
    throw new ImportError(
      "Le contenu ZIP/XLSX ne correspond pas au format CSV annoncé.",
    );
  let encoding: Encoding = "utf-8";
  let encodingNote = "UTF-8 probable · détection sans BOM à vérifier";
  if (sample[0] === 0xff && sample[1] === 0xfe) {
    encoding = "utf-16le";
    encodingNote = "UTF-16LE identifié par le BOM";
  } else if (sample[0] === 0xfe && sample[1] === 0xff) {
    throw new ImportError(
      "UTF-16BE n’est pas pris en charge. Enregistrez le fichier en UTF-8.",
    );
  } else if (sample.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    encodingNote = "UTF-8 identifié par le BOM";
  } else {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(sample, {
        stream: true,
      });
    } catch {
      encoding = "windows-1252";
      encodingNote =
        "Windows-1252 supposé après échec UTF-8 · vérifiez les accents";
    }
  }
  const text = new TextDecoder(encoding, { fatal: true }).decode(sample, {
    stream: true,
  });
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))
    throw new ImportError(
      "Le contenu semble binaire ou contient des caractères de contrôle interdits.",
    );
  const counts = new Map([
    [",", 0],
    [";", 0],
    ["\t", 0],
  ]);
  let quoted = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        i++;
        continue;
      }
      quoted = !quoted;
    }
    if (!quoted && (char === "\n" || char === "\r")) {
      if (started) break;
      continue;
    }
    if (!quoted && counts.has(char)) counts.set(char, counts.get(char)! + 1);
    if (char.trim()) started = true;
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted[0][1] === 0)
    throw new ImportError(
      "Aucun séparateur reconnu. Le CSV doit contenir au moins deux colonnes séparées par virgule, point-virgule ou tabulation.",
    );
  if (sorted[0][1] === sorted[1][1])
    throw new ImportError(
      "Le séparateur est ambigu. Réenregistrez le fichier avec un séparateur unique.",
    );
  return { encoding, encodingNote, delimiter: sorted[0][0] };
}

export async function analyzeCsv(
  source: Readable,
  sample: Buffer,
  options: ReadOptions = {},
  onRow?: (
    row: { line: number; values: string[] },
    headers: string[],
  ) => Promise<void>,
): Promise<Diagnostic> {
  let format: Pick<Diagnostic, "encoding" | "encodingNote" | "delimiter">;
  if (options.encoding && options.delimiter)
    format = {
      encoding: options.encoding,
      delimiter: options.delimiter,
      encodingNote: "Encodage sélectionné par l’utilisateur",
    };
  else {
    format = detectFormat(sample);
    if (options.encoding) {
      format.encoding = options.encoding;
      format.encodingNote = "Encodage sélectionné par l’utilisateur";
    }
    if (options.delimiter) format.delimiter = options.delimiter;
  }
  const diagnostic: Diagnostic = {
    ...format,
    headers: [],
    rowCount: 0,
    irregularRowCount: 0,
    warnings: [],
    preview: [],
    format: "csv",
    headerLine: options.headerLine ?? 1,
  };
  const decoder = new TextDecoder(format.encoding, { fatal: true });
  const decode = new Transform({
    transform(chunk, _, callback) {
      try {
        const text = decoder.decode(chunk, { stream: true });
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))
          throw new ImportError(
            "Le fichier contient des caractères de contrôle interdits.",
          );
        callback(null, text);
      } catch {
        callback(
          new ImportError(
            "Encodage incohérent ou contenu binaire. Enregistrez le CSV en UTF-8.",
          ),
        );
      }
    },
    flush(callback) {
      try {
        callback(null, decoder.decode());
      } catch {
        callback(
          new ImportError("Le fichier se termine par un caractère incomplet."),
        );
      }
    },
  });
  const parser = parse({
    delimiter: format.delimiter,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    max_record_size: LIMITS.recordSize,
    info: true,
    from_line: options.headerLine ?? 1,
  });
  try {
    await pipeline(source, decode, parser, async function (records) {
      for await (const entry of records) {
        const { record, info } = entry as {
          record: string[];
          info: { lines: number };
        };
        if (record.length > LIMITS.columns)
          throw new ImportError(
            `Le fichier dépasse ${LIMITS.columns} colonnes.`,
          );
        if (!diagnostic.headers.length) {
          diagnostic.headers = record;
          diagnostic.headerLine = info.lines;
          if (record.some((header) => !header.trim()))
            diagnostic.warnings.push(
              "Des en-têtes sont vides. Les colonnes restent identifiées par leur position.",
            );
          if (
            new Set(record.map((header) => header.trim().toLowerCase()))
              .size !== record.length
          )
            diagnostic.warnings.push(
              "Des en-têtes sont dupliqués. Aucune colonne n’a été fusionnée.",
            );
          continue;
        }
        diagnostic.rowCount++;
        if (diagnostic.rowCount > LIMITS.rows)
          throw new ImportError(
            `Le fichier dépasse ${LIMITS.rows.toLocaleString("fr-FR")} lignes de données.`,
          );
        if (record.length !== diagnostic.headers.length)
          diagnostic.irregularRowCount++;
        if (diagnostic.preview.length < LIMITS.preview)
          diagnostic.preview.push({ line: info.lines, values: record });
        if (onRow)
          await onRow({ line: info.lines, values: record }, diagnostic.headers);
      }
    });
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError(
      "Lecture CSV impossible : vérifiez les guillemets, les sauts de ligne et la taille des cellules (64 K caractères maximum par enregistrement).",
    );
  }
  if (!diagnostic.rowCount)
    throw new ImportError(
      "Le fichier ne contient aucune ligne de données après l’en-tête.",
    );
  if (diagnostic.irregularRowCount)
    diagnostic.warnings.push(
      `${diagnostic.irregularRowCount} ligne(s) ont un nombre de colonnes différent de l’en-tête. Les valeurs d’origine sont conservées.`,
    );
  return diagnostic;
}
