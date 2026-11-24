import type { ItemResult, StoreInfo, StoreProduct } from "@/domain/store-sync";
import {
  defaultTransport,
  readJsonResponse,
  storeFetch,
  StoreError,
  type Transport,
} from "./network";
import type { PushOptions, StoreClient } from "./types";

type WooProduct = { id: number; sku: string; type: string; parent_id?: number };
type WooItem = {
  id: number;
  sku?: string;
  error?: { code: string; message: string };
};

/**
 * WooCommerce REST API v3 adapter. Basic authentication over HTTPS only
 * (the base URL is validated by normalizeWooUrl). Batches of at most 100.
 */
export function wooClient(
  baseUrl: string,
  consumerKey: string,
  consumerSecret: string,
  transport: Transport = defaultTransport,
): StoreClient {
  const authorization = `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64")}`;
  const api = (path: string) => `${baseUrl}/wp-json/wc/v3${path}`;

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await storeFetch(transport, api(path), {
      ...init,
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    const body = await readJsonResponse<T & { message?: string }>(response);
    if (!response.ok)
      throw new StoreError(
        `WooCommerce a refusé la requête : ${body.message ?? `HTTP ${response.status}`}`,
      );
    return body;
  }

  async function probe(): Promise<StoreInfo> {
    const [currency, taxes] = await Promise.all([
      call<{ value: string }>("/settings/general/woocommerce_currency"),
      call<{ value: string }>("/settings/tax/woocommerce_prices_include_tax"),
    ]);
    return {
      name: new URL(baseUrl).hostname,
      currency: currency.value,
      pricesIncludeTax: taxes.value === "yes",
    };
  }

  function payload(product: StoreProduct, options: PushOptions, id?: number) {
    const stock =
      product.stock !== null
        ? { manage_stock: true, stock_quantity: product.stock }
        : {};
    if (id && options.updateMode === "price_stock")
      return { id, regular_price: product.price, ...stock };
    return {
      ...(id
        ? { id }
        : {
            type: "simple",
            status: "draft",
            sku: product.sku,
            images: product.images.map((src) => ({ src })),
          }),
      name: product.title,
      description: product.descriptionHtml,
      regular_price: product.price,
      ...stock,
      ...(product.barcode ? { global_unique_id: product.barcode } : {}),
      meta_data: [
        ...(product.oemReference
          ? [{ key: "oem_reference", value: product.oemReference }]
          : []),
        ...(product.vendor
          ? [{ key: "catamotive_brand", value: product.vendor }]
          : []),
      ],
    };
  }

  async function push(
    products: StoreProduct[],
    options: PushOptions,
  ): Promise<ItemResult[]> {
    if (!products.length) return [];
    const results = new Map<number, ItemResult>();
    const lookupable = products.filter((product) => {
      if (!product.sku.includes(",")) return true;
      results.set(product.line, {
        line: product.line,
        sku: product.sku,
        outcome: "skipped",
        message:
          "SKU contenant une virgule : non pris en charge par WooCommerce.",
      });
      return false;
    });
    const found = new Map<string, WooProduct[]>();
    if (lookupable.length) {
      const query = new URLSearchParams({
        sku: lookupable.map((product) => product.sku).join(","),
        per_page: "100",
        status: "any",
        _fields: "id,sku,type,parent_id",
      });
      for (const item of await call<WooProduct[]>(`/products?${query}`))
        found.set(item.sku, [...(found.get(item.sku) ?? []), item]);
    }
    const creates: StoreProduct[] = [];
    const updates: { product: StoreProduct; id: number }[] = [];
    for (const product of lookupable) {
      const base = { line: product.line, sku: product.sku };
      const matches = found.get(product.sku) ?? [];
      const existing = matches[0];
      if (matches.length > 1)
        results.set(product.line, {
          ...base,
          outcome: "skipped",
          message: "Ce SKU existe plusieurs fois dans la boutique.",
        });
      else if (existing && existing.type !== "simple")
        results.set(product.line, {
          ...base,
          outcome: "skipped",
          message: `Produit WooCommerce de type « ${existing.type} » : seuls les produits simples sont mis à jour.`,
        });
      else if (options.dryRun)
        results.set(product.line, {
          ...base,
          outcome: existing ? "updated" : "created",
        });
      else if (existing) updates.push({ product, id: existing.id });
      else creates.push(product);
    }
    if (creates.length || updates.length) {
      const body = await call<{ create?: WooItem[]; update?: WooItem[] }>(
        "/products/batch",
        {
          method: "POST",
          body: JSON.stringify({
            create: creates.map((product) => payload(product, options)),
            update: updates.map(({ product, id }) =>
              payload(product, options, id),
            ),
          }),
        },
      );
      const settle = (
        product: StoreProduct,
        item: WooItem | undefined,
        outcome: "created" | "updated",
      ) =>
        results.set(product.line, {
          line: product.line,
          sku: product.sku,
          ...(item?.error || !item
            ? {
                outcome: "failed" as const,
                message:
                  item?.error?.message ?? "Réponse WooCommerce incomplète.",
              }
            : { outcome }),
        });
      creates.forEach((product, index) =>
        settle(product, body.create?.[index], "created"),
      );
      updates.forEach(({ product }, index) =>
        settle(product, body.update?.[index], "updated"),
      );
    }
    return products.map((product) => results.get(product.line)!);
  }

  return { probe, push };
}
