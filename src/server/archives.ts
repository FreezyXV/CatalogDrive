import { basename } from "node:path";
import type { Readable } from "node:stream";
import yauzl from "yauzl";
import { ImportError } from "@/domain/csv";

export type ArchiveEntry = {
  name: string;
  filename: string;
  declaredBytes: number;
};

export type ArchiveLimits = {
  entries: number;
  entryBytes: number;
  totalBytes: number;
};

export const PILOT_ARCHIVE_LIMITS: ArchiveLimits = {
  entries: 20,
  entryBytes: 5 * 1024 * 1024,
  totalBytes: 100 * 1024 * 1024,
};

function validEntryName(name: string) {
  if (
    !name ||
    name.length > 500 ||
    name.startsWith("/") ||
    name.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(name) ||
    name.split("/").some((part) => part === ".." || part === ".")
  )
    throw new ImportError("L’archive contient un chemin de fichier dangereux.");
  const filename = basename(name);
  if (filename.length > 180)
    throw new ImportError(
      "Un nom de fichier dans le ZIP dépasse 180 caractères.",
    );
  return filename;
}

export async function forEachCatalogArchiveEntry(
  path: string,
  limits: ArchiveLimits,
  onEntry: (
    entry: ArchiveEntry,
    source: Readable,
    maxBytes: number,
  ) => Promise<number>,
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
    throw new ImportError("Archive ZIP invalide ou chiffrée.");
  }
  let entries = 0;
  let total = 0;
  try {
    for await (const raw of zip.eachEntry()) {
      const name = raw.fileName;
      if (name.endsWith("/")) continue;
      if (
        name.startsWith("__MACOSX/") ||
        name === ".DS_Store" ||
        name.endsWith("/.DS_Store")
      )
        continue;
      const filename = validEntryName(name);
      const unixMode = (raw.externalFileAttributes >>> 16) & 0xffff;
      if ((unixMode & 0xf000) === 0xa000)
        throw new ImportError(
          "Les liens symboliques dans un ZIP sont refusés.",
        );
      if (raw.generalPurposeBitFlag & 1)
        throw new ImportError("Les ZIP chiffrés ne sont pas pris en charge.");
      if (!/\.(csv|xlsx)$/i.test(filename))
        throw new ImportError(
          `Format non pris en charge dans le ZIP : ${filename}. Utilisez CSV ou XLSX.`,
        );
      entries++;
      if (entries > limits.entries)
        throw new ImportError(
          `Le ZIP dépasse la limite de ${limits.entries} fichiers catalogue.`,
        );
      if (!raw.uncompressedSize || raw.uncompressedSize > limits.entryBytes)
        throw new ImportError(
          `Le fichier ${filename} est vide ou dépasse la limite par fichier.`,
        );
      if (total + raw.uncompressedSize > limits.totalBytes)
        throw new ImportError(
          "Le ZIP dépasse la limite décompressée autorisée.",
        );
      const source = await zip.openReadStreamPromise(raw);
      const actualBytes = await onEntry(
        { name, filename, declaredBytes: raw.uncompressedSize },
        source,
        Math.min(limits.entryBytes, limits.totalBytes - total),
      );
      if (actualBytes !== raw.uncompressedSize)
        throw new ImportError(
          "La taille réelle d’une entrée ZIP est incohérente.",
        );
      total += actualBytes;
    }
    if (!entries)
      throw new ImportError("Le ZIP ne contient aucun fichier CSV ou XLSX.");
    return { entries, totalBytes: total };
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError(
      "Le ZIP est invalide ou contient une entrée endommagée.",
    );
  } finally {
    zip.close();
  }
}
