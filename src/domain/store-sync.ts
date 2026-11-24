import { z } from "zod";
import type { CatalogData } from "./catalog";

/**
 * Direct export to an online store (docs/integration/CONNECTEURS_CMS.md).
 * Pure functions only: no network, no database.
 */
export const STORE_PLATFORMS = {
  shopify: "Shopify",
  woocommerce: "WooCommerce",
} as const;
export type StorePlatform = keyof typeof STORE_PLATFORMS;

export const SHOPIFY_API_VERSION = "2025-10";

const SHOPIFY_DOMAIN = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;

/** Accepts "boutique", "boutique.myshopify.com" or an admin URL. */
export function normalizeShopifyDomain(input: string) {
  let value = input.trim().toLowerCase();
  if (/^https?:\/\//.test(value)) {
    try {
      value = new URL(value).hostname;
    } catch {
      throw new Error("Domaine Shopify invalide.");
    }
  }
  value = value.replace(/\/.*$/, "");
  if (!value.includes(".")) value = `${value}.myshopify.com`;
  if (!SHOPIFY_DOMAIN.test(value))
    throw new Error(
      "Indiquez le domaine d’administration Shopify, de la forme boutique.myshopify.com.",
    );
  return value;
}

/** Store base URL (WordPress may live in a sub-directory). HTTPS only. */
export function normalizeWooUrl(input: string) {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("URL WooCommerce invalide.");
  }
  if (url.protocol !== "https:")
    throw new Error(
      "La boutique WooCommerce doit être servie en HTTPS : les clés d’API transitent dans chaque requête.",
    );
  if (url.username || url.password)
    throw new Error("L’URL ne doit pas contenir d’identifiants.");
  if (url.port && url.port !== "443")
    throw new Error("Seul le port HTTPS standard (443) est accepté.");
  if (url.search || url.hash)
    throw new Error("L’URL ne doit contenir ni paramètres ni ancre.");
  if (!url.hostname.includes(".") || /^[\d.]+$|:/.test(url.hostname))
    throw new Error("Indiquez un nom de domaine public, pas une adresse IP.");
  const path = url.pathname.replace(/\/+$/, "").replace(/\/wp-json.*$/, "");
  return `https://${url.hostname.toLowerCase()}${path}`;
}

export const connectionInputSchema = z.discriminatedUnion("platform", [
  z.object({
    platform: z.literal("shopify"),
    label: z.string().trim().min(1).max(80),
    address: z.string().trim().min(1).max(200),
    accessToken: z
      .string()
      .trim()
      .regex(
        /^shp(at|ca|pa)_[A-Za-z0-9]{20,100}$/,
        "Jeton Admin API Shopify invalide (shpat_…).",
      ),
  }),
  z.object({
    platform: z.literal("woocommerce"),
    label: z.string().trim().min(1).max(80),
    address: z.string().trim().min(1).max(300),
    consumerKey: z
      .string()
      .trim()
      .regex(/^ck_[A-Za-z0-9]{20,80}$/, "Clé client WooCommerce invalide."),
    consumerSecret: z
      .string()
      .trim()
      .regex(/^cs_[A-Za-z0-9]{20,80}$/, "Secret client WooCommerce invalide."),
  }),
]);
export type ConnectionInput = z.infer<typeof connectionInputSchema>;
export type StoreCredentials =
  | { platform: "shopify"; accessToken: string }
  | { platform: "woocommerce"; consumerKey: string; consumerSecret: string };

export const SYNC_UPDATE_MODES = {
  all: "Fiche complète (titre, description, marque, prix, stock)",
  price_stock: "Prix et stock seulement",
} as const;
export const syncOptionsSchema = z.object({
  connectionId: z.uuid(),
  updateMode: z.enum(["all", "price_stock"]).default("price_stock"),
  dryRun: z.boolean().default(false),
});
export type SyncOptions = z.infer<typeof syncOptionsSchema>;

export type StoreInfo = {
  name: string;
  currency: string;
  pricesIncludeTax: boolean;
};

/** Platform-neutral product built from the canonical data model. */
export type StoreProduct = {
  line: number;
  sku: string;
  title: string;
  descriptionHtml: string;
  price: string;
  stock: number | null;
  vendor: string;
  productType: string;
  barcode: string;
  oemReference: string;
  images: string[];
};

export type ItemOutcome = "created" | "updated" | "skipped" | "failed";
export type ItemResult = {
  line: number;
  sku: string;
  outcome: ItemOutcome;
  message?: string;
};

/** Text (already stripped of HTML by normalization) to safe HTML. */
export function textToHtml(value: string) {
  return value
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\r?\n/g, "<br>");
}

export function toStoreProduct(data: CatalogData, line: number): StoreProduct {
  return {
    line,
    sku: data.sku ?? "",
    title: data.product_name ?? "",
    descriptionHtml: textToHtml(data.description ?? ""),
    price: data.sale_price ?? "",
    stock:
      data.stock_quantity && /^\d+$/.test(data.stock_quantity)
        ? Number(data.stock_quantity)
        : null,
    vendor: data.brand ?? "",
    productType: data.category ?? "",
    barcode: data.ean ?? "",
    oemReference: data.oem_reference ?? "",
    images: (data.image_urls ?? "")
      .split(" | ")
      .map((url) => url.trim())
      .filter(Boolean)
      .slice(0, 10),
  };
}

/**
 * Store-level checks, on top of the rules shared with file exports.
 * Returns the reasons a row must not be sent.
 */
export function storeRowErrors(
  data: CatalogData,
  store: StoreInfo,
  defaultCurrency: string,
) {
  const errors: string[] = [];
  const currency = (data.currency || defaultCurrency).toUpperCase();
  if (currency !== store.currency.toUpperCase())
    errors.push(
      `Devise ${currency} différente de celle de la boutique (${store.currency}). Aucune conversion n’est appliquée.`,
    );
  return errors;
}

export function priceBasisMismatch(
  sourcePriceBasis: "excl_tax" | "incl_tax",
  store: StoreInfo,
) {
  const storeBasis = store.pricesIncludeTax ? "incl_tax" : "excl_tax";
  if (storeBasis === sourcePriceBasis) return null;
  return store.pricesIncludeTax
    ? "La boutique saisit ses prix TTC alors que la source est en HT. Aucune conversion fiscale implicite : corrigez la convention de la source ou le réglage de la boutique."
    : "La boutique saisit ses prix HT alors que la source est en TTC. Aucune conversion fiscale implicite : corrigez la convention de la source ou le réglage de la boutique.";
}

export function maskSecret(value: string) {
  return `…${value.slice(-4)}`;
}
