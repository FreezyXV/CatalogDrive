import { z } from "zod";
import {
  FIELDS,
  fieldKeys,
  fieldSchema,
  type CatalogData,
  type Field,
} from "./catalog";

export const PROFILES = {
  generic: "CSV normalisé",
  woocommerce: "WooCommerce",
  prestashop: "PrestaShop",
  shopify: "Shopify",
  custom: "CSV personnalisé",
} as const;
export const exportConfigSchema = z
  .object({
    profile: z.enum([
      "generic",
      "woocommerce",
      "prestashop",
      "shopify",
      "custom",
    ]),
    columns: z
      .array(
        z.object({
          field: z.union([
            fieldSchema,
            z.enum([
              "source_row_number",
              "validation_status",
              "confidence_score",
            ]),
          ]),
          header: z.string().trim().min(1).max(100),
        }),
      )
      .min(1)
      .max(30),
    delimiter: z.enum([",", ";", "\t"]).default(";"),
    encoding: z
      .enum(["utf-8", "utf-8-bom", "windows-1252"])
      .default("utf-8-bom"),
    priceBasis: z.enum(["excl_tax", "incl_tax"]).default("excl_tax"),
    shopifySingleLocation: z.boolean().default(true),
  })
  .refine(
    (config) =>
      new Set(config.columns.map((c) => c.header)).size ===
      config.columns.length,
    "Les en-têtes d’export doivent être uniques.",
  );
export type ExportConfig = z.infer<typeof exportConfigSchema>;
const wooHeaders: Partial<Record<Field, string>> = {
  sku: "SKU",
  product_name: "Name",
  description: "Description",
  sale_price: "Regular price",
  stock_quantity: "Stock",
  category: "Categories",
  image_urls: "Images",
  brand: "Brands",
  ean: "GTIN, UPC, EAN, or ISBN",
  oem_reference: "meta:oem_reference",
};
const prestaHeaders: Partial<Record<Field, string>> = {
  sku: "Reference #",
  product_name: "Name *",
  description: "Description",
  sale_price: "Price tax excluded",
  stock_quantity: "Quantity",
  brand: "Brand",
  category: "Categories (x,y,z...)",
  image_urls: "Image URLs (x,y,z...)",
  ean: "EAN13",
  condition: "Condition",
};
const shopifyHeaders: Partial<Record<Field, string>> = {
  sku: "SKU",
  product_name: "Title",
  description: "Description",
  sale_price: "Price",
  stock_quantity: "Inventory quantity",
  brand: "Vendor",
  category: "Type",
  image_urls: "Product image URL",
  ean: "Barcodes",
};
export function defaultExportConfig(
  profile: ExportConfig["profile"],
): ExportConfig {
  const headers =
    profile === "woocommerce"
      ? wooHeaders
      : profile === "prestashop"
        ? prestaHeaders
        : profile === "shopify"
          ? shopifyHeaders
          : Object.fromEntries(fieldKeys.map((field) => [field, field]));
  return {
    profile,
    columns: Object.entries(headers).map(([field, header]) => ({
      field: field as Field,
      header,
    })),
    delimiter: ["woocommerce", "shopify"].includes(profile) ? "," : ";",
    encoding: "utf-8-bom",
    priceBasis: "excl_tax",
    shopifySingleLocation: true,
  };
}
export function validateExportConfig(config: ExportConfig) {
  if (
    ["woocommerce", "shopify"].includes(config.profile) &&
    (config.delimiter !== "," || config.encoding === "windows-1252")
  )
    throw new Error(
      "WooCommerce et Shopify exigent ici un CSV UTF-8 séparé par virgules.",
    );
  if (!["generic", "custom"].includes(config.profile)) {
    const required = defaultExportConfig(config.profile).columns.filter((c) =>
      ["sku", "product_name", "sale_price"].includes(c.field),
    );
    for (const column of required)
      if (
        !config.columns.some(
          (c) => c.field === column.field && c.header === column.header,
        )
      )
        throw new Error(
          `Le profil ${PROFILES[config.profile]} exige la colonne ${column.header}. Utilisez le profil personnalisé pour renommer librement les champs.`,
        );
  }
  const reserved =
    config.profile === "woocommerce"
      ? ["Type", "Published"]
      : config.profile === "prestashop"
        ? ["Active (0/1)"]
        : config.profile === "shopify"
          ? [
              "URL handle",
              "Option1 name",
              "Option1 value",
              "Status",
              "Published on online store",
              "Inventory tracker",
              "Continue selling when out of stock",
              "Fulfillment service",
            ]
          : [];
  if (config.columns.some((c) => reserved.includes(c.header)))
    throw new Error(
      "Un en-tête entre en conflit avec une colonne technique obligatoire du profil CMS.",
    );
  if (config.profile === "prestashop" && config.priceBasis !== "excl_tax")
    throw new Error(
      "Le profil PrestaShop utilise des prix hors taxes. Choisissez une source HT ou un export personnalisé.",
    );
}
export function cmsErrors(
  data: CatalogData,
  config: ExportConfig,
  sourcePriceBasis: "excl_tax" | "incl_tax",
) {
  const errors: string[] = [];
  if (!["generic", "custom"].includes(config.profile)) {
    if (
      !data.sku ||
      !data.product_name ||
      !data.sale_price ||
      !/^\d+(\.\d{1,2})?$/.test(data.sale_price)
    )
      errors.push(
        "SKU, désignation et prix de vente valide requis pour le CMS.",
      );
    if (sourcePriceBasis !== config.priceBasis)
      errors.push(
        "La convention HT/TTC de l’export doit correspondre à celle de la source. Aucune conversion fiscale implicite.",
      );
    if (config.profile === "prestashop" && data.ean && data.ean.length !== 13)
      errors.push("Le champ EAN13 PrestaShop exige exactement 13 chiffres.");
    if (
      config.profile === "shopify" &&
      !config.shopifySingleLocation &&
      data.stock_quantity
    )
      errors.push(
        "Le stock Shopify multi-emplacements exige un fichier d’inventaire dédié.",
      );
  }
  return errors;
}
export function shopifyHandle(value: string) {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return `cm-${slug || "produit"}`;
}
export function exportRecord(
  data: CatalogData,
  meta: { line: number; confidence: string },
  config: ExportConfig,
) {
  const result: Record<string, string> = {};
  if (config.profile === "woocommerce")
    Object.assign(result, { Type: "simple", Published: "0" });
  if (config.profile === "prestashop") result["Active (0/1)"] = "0";
  if (config.profile === "shopify")
    Object.assign(result, {
      "URL handle": shopifyHandle(data.sku ?? String(meta.line)),
      "Option1 name": "Title",
      "Option1 value": "Default Title",
      Status: "draft",
      "Published on online store": "false",
      "Inventory tracker": data.stock_quantity ? "shopify" : "",
      "Continue selling when out of stock": "deny",
      "Fulfillment service": "manual",
    });
  for (const column of config.columns) {
    let value =
      column.field === "source_row_number"
        ? String(meta.line)
        : column.field === "confidence_score"
          ? meta.confidence
          : column.field === "validation_status"
            ? "valid"
            : (data[column.field] ?? "");
    if (
      column.field === "image_urls" &&
      !["generic", "custom"].includes(config.profile)
    )
      value =
        config.profile === "shopify"
          ? value.split(" | ")[0]
          : value.replaceAll(" | ", ", ");
    result[column.header] = value;
  }
  return result;
}
export const safeCsvCell = (value: string) =>
  /^[\s\uFEFF]*[=+\-@\t\r\n]/.test(value) ? `'${value}` : value;
export const exportFieldLabel = (
  field: ExportConfig["columns"][number]["field"],
) => (field in FIELDS ? FIELDS[field as Field] : field);
