export const CATALOG_EXTENSIONS = [
  "csv",
  "tsv",
  "txt",
  "xls",
  "xlsx",
  "ods",
] as const;
export const IMPORT_EXTENSIONS = [...CATALOG_EXTENSIONS, "zip"] as const;
export const IMPORT_FORMAT_LABEL = IMPORT_EXTENSIONS.map((extension) =>
  extension.toUpperCase(),
).join(" · ");
export const IMPORT_FILE_ACCEPT = IMPORT_EXTENSIONS.map(
  (extension) => `.${extension}`,
).join(",");
export function isCatalogFilename(filename: string) {
  return CATALOG_EXTENSIONS.some((extension) =>
    filename.toLowerCase().endsWith(`.${extension}`),
  );
}
export function isImportFilename(filename: string) {
  return isCatalogFilename(filename) || filename.toLowerCase().endsWith(".zip");
}
