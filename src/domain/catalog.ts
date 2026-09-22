import { z } from "zod";

export const FIELDS = {
  supplier_reference: "Référence fournisseur",
  sku: "SKU",
  oem_reference: "Référence OEM",
  ean: "EAN",
  brand: "Marque",
  product_name: "Désignation",
  description: "Description",
  category: "Catégorie",
  purchase_price: "Prix d’achat",
  sale_price: "Prix de vente",
  currency: "Devise",
  tax_rate: "TVA (%)",
  stock_quantity: "Stock",
  condition: "État",
  manufacturer_reference: "Référence fabricant",
  vehicle_information_raw: "Informations véhicule (brutes)",
  engine_code_raw: "Code moteur (brut)",
  year_from_raw: "Année début (brute)",
  year_to_raw: "Année fin (brute)",
  image_urls: "URLs des images",
} as const;
export type Field = keyof typeof FIELDS;
export const fieldKeys = Object.keys(FIELDS) as Field[];
export type CatalogData = Partial<Record<Field, string>>;
export type Mapping = Partial<Record<Field, number>>;
export const fieldSchema = z.enum(fieldKeys as [Field, ...Field[]]);
export const readOptionsSchema = z.object({
  headerLine: z.number().int().min(1).max(1000).optional(),
  delimiter: z.enum([",", ";", "\t"]).optional(),
  encoding: z.enum(["utf-8", "utf-16le", "windows-1252"]).optional(),
  sheet: z.string().max(100).optional(),
});
export type ReadOptions = z.infer<typeof readOptionsSchema>;
export const ruleConfigSchema = z.object({
  stripReferenceSeparators: z.boolean().default(true),
  normalizeBrands: z.boolean().default(true),
  brandAliases: z
    .record(z.string().max(80), z.string().max(80))
    .refine((value) => Object.keys(value).length <= 100)
    .default({}),
  defaultCurrency: z
    .enum([
      "EUR",
      "USD",
      "GBP",
      "CHF",
      "CAD",
      "MAD",
      "TND",
      "DZD",
      "PLN",
      "CZK",
      "SEK",
      "NOK",
      "DKK",
      "RON",
      "BGN",
      "HUF",
      "TRY",
      "JPY",
      "CNY",
      "AUD",
    ])
    .default("EUR"),
  priceBasis: z.enum(["excl_tax", "incl_tax"]).default("excl_tax"),
  required: z.array(fieldSchema).max(20).default(["sku", "product_name"]),
  fuzzyDuplicates: z.boolean().default(true),
});
export type RuleConfig = z.infer<typeof ruleConfigSchema>;
export const DEFAULT_RULES = ruleConfigSchema.parse({});
export const mappingSchema = z.partialRecord(
  fieldSchema,
  z.number().int().min(0).max(199),
);
export type Transformation = {
  field: Field;
  original: string;
  value: string;
  rule: string;
  version: string;
  at: string;
  origin: string;
};
export type Issue = {
  id: string;
  field: Field | "_row";
  code: string;
  message: string;
  severity: "error" | "warning";
  original: string;
  suggestion?: string;
  score?: number;
  relatedLine?: number;
};
export type Decision = {
  issueId: string;
  action: "accept" | "edit" | "keep";
  value?: string;
  at: string;
  actor: string;
  original: string;
  result: string;
};
export type NormalizedRow = {
  data: CatalogData;
  transformations: Transformation[];
  issues: Issue[];
  status: "valid" | "ambiguous" | "invalid";
  confidence: number;
};
export type QualityCounts = {
  total: number;
  valid: number;
  ambiguous: number;
  invalid: number;
  excluded: number;
  duplicates: number;
  transformed: number;
};
export const emptyCounts = (): QualityCounts => ({
  total: 0,
  valid: 0,
  ambiguous: 0,
  invalid: 0,
  excluded: 0,
  duplicates: 0,
  transformed: 0,
});
export const normalizeHeader = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
const aliases: Record<Field, string[]> = {
  supplier_reference: [
    "reference",
    "ref",
    "referencefournisseur",
    "reffournisseur",
    "supplierreference",
    "codearticle",
    "article",
  ],
  sku: ["sku", "stockkeepingunit", "referenceinterne"],
  oem_reference: ["oem", "referenceoem", "refoem", "oe"],
  ean: ["ean", "ean13", "gtin", "codebarre", "barcode"],
  brand: ["marque", "brand", "manufacturer"],
  product_name: [
    "designation",
    "nom",
    "name",
    "productname",
    "produit",
    "libelle",
    "title",
  ],
  description: ["description", "descriptif", "details"],
  category: ["categorie", "category", "famille"],
  purchase_price: ["prixachat", "purchaseprice", "cout", "cost", "pa"],
  sale_price: ["prix", "price", "prixvente", "saleprice", "pv", "regularprice"],
  currency: ["devise", "currency"],
  tax_rate: ["tva", "taxrate", "vat"],
  stock_quantity: ["stock", "quantite", "qty", "quantity", "stockquantity"],
  condition: ["etat", "condition"],
  manufacturer_reference: [
    "referencefabricant",
    "manufacturerreference",
    "mpn",
  ],
  vehicle_information_raw: [
    "vehicule",
    "vehicle",
    "vehicleinformation",
    "compatibilite",
  ],
  engine_code_raw: ["codemoteur", "enginecode"],
  year_from_raw: ["anneedebut", "yearfrom"],
  year_to_raw: ["anneefin", "yearto"],
  image_urls: ["images", "image", "imageurls", "imageurl", "photos", "photo"],
};
export function suggestMapping(headers: string[]) {
  const mapping: Mapping = {};
  const used = new Set<number>();
  for (const field of fieldKeys) {
    const index = headers.findIndex(
      (header, index) =>
        !used.has(index) &&
        [normalizeHeader(field), ...aliases[field]].includes(
          normalizeHeader(header),
        ),
    );
    if (index >= 0) {
      mapping[field] = index;
      used.add(index);
    }
  }
  return mapping;
}
export function validateMapping(mapping: Mapping, columnCount: number) {
  const values = Object.values(mapping);
  if (
    !values.length ||
    mapping.product_name === undefined ||
    (mapping.sku === undefined && mapping.supplier_reference === undefined)
  )
    throw new Error(
      "Associez une désignation et un SKU ou une référence fournisseur.",
    );
  if (
    values.some((index) => index === undefined || index >= columnCount) ||
    new Set(values).size !== values.length
  )
    throw new Error(
      "Chaque colonne source ne peut être associée qu’une fois, et doit exister dans le fichier.",
    );
}
export const RULE_VERSION = "1.0.0";
