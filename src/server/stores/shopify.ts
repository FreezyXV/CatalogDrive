import {
  SHOPIFY_API_VERSION,
  type ItemResult,
  type StoreInfo,
  type StoreProduct,
} from "@/domain/store-sync";
import { shopifyHandle } from "@/domain/exports";
import {
  defaultTransport,
  readJsonResponse,
  storeFetch,
  StoreError,
  type Transport,
} from "./network";
import type { PushOptions, StoreClient } from "./types";

type GraphqlResponse<T> = {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
};
type UserError = { field?: string[] | null; message: string };
type ExistingVariant = {
  id: string;
  sku: string | null;
  inventoryItem: { id: string; tracked: boolean };
  product: { id: string; variantsCount: { count: number } | null };
};

const quote = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
const messages = (errors: UserError[]) =>
  errors.map((error) => error.message).join(" ; ");

const PROBE = `query { shop { name currencyCode taxesIncluded } location { id } }`;
const LOOKUP = `query($q: String!) {
  productVariants(first: 250, query: $q) {
    nodes { id sku inventoryItem { id tracked } product { id variantsCount { count } } }
  }
}`;
const CREATE = `mutation($input: ProductSetInput!) {
  productSet(synchronous: true, input: $input) {
    product { id }
    userErrors { field message }
  }
}`;
const UPDATE_PRODUCT = `mutation($product: ProductUpdateInput!) {
  productUpdate(product: $product) { userErrors { field message } }
}`;
const UPDATE_VARIANT = `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    userErrors { field message }
  }
}`;
const SET_STOCK = `mutation($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) { userErrors { field message } }
}`;

/**
 * Shopify Admin GraphQL adapter, API version pinned (SHOPIFY_API_VERSION).
 * Single-variant products only: a product with several variants is skipped,
 * never rewritten, because the CatalogDrive model has no variant concept.
 */
export function shopifyClient(
  domain: string,
  accessToken: string,
  transport: Transport = defaultTransport,
): StoreClient {
  const endpoint = `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  let locationId: string | null | undefined;

  async function graphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const response = await storeFetch(transport, endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables }),
      });
      const body = await readJsonResponse<GraphqlResponse<T>>(response);
      const throttled = body.errors?.some(
        (error) => error.extensions?.code === "THROTTLED",
      );
      if (throttled && attempt < 6) {
        await transport.sleep(2000 * attempt);
        continue;
      }
      if (throttled)
        throw new StoreError("Limite de débit Shopify atteinte.", false);
      if (body.errors?.length) {
        const denied = body.errors.some(
          (error) => error.extensions?.code === "ACCESS_DENIED",
        );
        throw new StoreError(
          denied
            ? "Le jeton Shopify n’a pas les autorisations nécessaires (write_products, read_locations, write_inventory)."
            : `Shopify a refusé la requête : ${body.errors[0].message}`,
        );
      }
      if (!response.ok || !body.data)
        throw new StoreError(
          `Shopify a refusé la requête (HTTP ${response.status}).`,
        );
      return body.data;
    }
  }

  async function probe(): Promise<StoreInfo> {
    const data = await graphql<{
      shop: { name: string; currencyCode: string; taxesIncluded: boolean };
      location: { id: string } | null;
    }>(PROBE);
    locationId = data.location?.id ?? null;
    return {
      name: data.shop.name,
      currency: data.shop.currencyCode,
      pricesIncludeTax: data.shop.taxesIncluded,
    };
  }

  async function lookup(skus: string[]) {
    const data = await graphql<{
      productVariants: { nodes: ExistingVariant[] };
    }>(LOOKUP, { q: skus.map((sku) => `sku:${quote(sku)}`).join(" OR ") });
    const found = new Map<string, ExistingVariant[]>();
    for (const node of data.productVariants.nodes)
      if (node.sku) found.set(node.sku, [...(found.get(node.sku) ?? []), node]);
    return found;
  }

  function createInput(product: StoreProduct) {
    const stocked = product.stock !== null;
    return {
      title: product.title,
      handle: shopifyHandle(product.sku),
      descriptionHtml: product.descriptionHtml,
      vendor: product.vendor || undefined,
      productType: product.productType || undefined,
      status: "DRAFT",
      productOptions: [
        { name: "Title", position: 1, values: [{ name: "Default Title" }] },
      ],
      variants: [
        {
          optionValues: [{ optionName: "Title", name: "Default Title" }],
          price: product.price,
          barcode: product.barcode || undefined,
          inventoryItem: { sku: product.sku, tracked: stocked },
          inventoryQuantities:
            stocked && locationId
              ? [{ locationId, name: "available", quantity: product.stock }]
              : undefined,
        },
      ],
      files: product.images.length
        ? product.images.map((url) => ({
            originalSource: url,
            contentType: "IMAGE",
          }))
        : undefined,
      metafields: product.oemReference
        ? [
            {
              namespace: "catamotive",
              key: "oem_reference",
              type: "single_line_text_field",
              value: product.oemReference,
            },
          ]
        : undefined,
    };
  }

  async function create(product: StoreProduct): Promise<ItemResult> {
    const base = { line: product.line, sku: product.sku };
    const data = await graphql<{
      productSet: { product: { id: string } | null; userErrors: UserError[] };
    }>(CREATE, { input: createInput(product) });
    if (data.productSet.userErrors.length || !data.productSet.product)
      return {
        ...base,
        outcome: "failed",
        message: messages(data.productSet.userErrors) || "Création refusée.",
      };
    return { ...base, outcome: "created" };
  }

  async function update(
    product: StoreProduct,
    existing: ExistingVariant,
    options: PushOptions,
  ): Promise<ItemResult> {
    const base = { line: product.line, sku: product.sku };
    if (options.updateMode === "all") {
      const data = await graphql<{
        productUpdate: { userErrors: UserError[] };
      }>(UPDATE_PRODUCT, {
        product: {
          id: existing.product.id,
          title: product.title,
          descriptionHtml: product.descriptionHtml,
          vendor: product.vendor,
          productType: product.productType,
          ...(product.oemReference
            ? {
                metafields: [
                  {
                    namespace: "catamotive",
                    key: "oem_reference",
                    type: "single_line_text_field",
                    value: product.oemReference,
                  },
                ],
              }
            : {}),
        },
      });
      if (data.productUpdate.userErrors.length)
        return {
          ...base,
          outcome: "failed",
          message: messages(data.productUpdate.userErrors),
        };
    }
    const data = await graphql<{
      productVariantsBulkUpdate: { userErrors: UserError[] };
    }>(UPDATE_VARIANT, {
      productId: existing.product.id,
      variants: [
        {
          id: existing.id,
          price: product.price,
          ...(options.updateMode === "all" && product.barcode
            ? { barcode: product.barcode }
            : {}),
          ...(product.stock !== null && !existing.inventoryItem.tracked
            ? { inventoryItem: { tracked: true } }
            : {}),
        },
      ],
    });
    if (data.productVariantsBulkUpdate.userErrors.length)
      return {
        ...base,
        outcome: "failed",
        message: messages(data.productVariantsBulkUpdate.userErrors),
      };
    return { ...base, outcome: "updated" };
  }

  async function push(
    products: StoreProduct[],
    options: PushOptions,
  ): Promise<ItemResult[]> {
    if (!products.length) return [];
    if (locationId === undefined) await probe();
    const found = await lookup(products.map((product) => product.sku));
    const results: ItemResult[] = [];
    const stock: {
      inventoryItemId: string;
      quantity: number;
      index: number;
    }[] = [];
    for (const product of products) {
      const base = { line: product.line, sku: product.sku };
      const matches = found.get(product.sku) ?? [];
      if (matches.length > 1) {
        results.push({
          ...base,
          outcome: "skipped",
          message: "Ce SKU existe plusieurs fois dans la boutique.",
        });
        continue;
      }
      const existing = matches[0];
      if (existing && (existing.product.variantsCount?.count ?? 1) > 1) {
        results.push({
          ...base,
          outcome: "skipped",
          message:
            "Produit à variantes dans la boutique : non modifié pour ne pas écraser ses autres variantes.",
        });
        continue;
      }
      if (options.dryRun) {
        results.push({ ...base, outcome: existing ? "updated" : "created" });
        continue;
      }
      const result = existing
        ? await update(product, existing, options)
        : await create(product);
      results.push(result);
      if (
        existing &&
        result.outcome === "updated" &&
        product.stock !== null &&
        locationId
      )
        stock.push({
          inventoryItemId: existing.inventoryItem.id,
          quantity: product.stock,
          index: results.length - 1,
        });
    }
    if (stock.length) {
      const data = await graphql<{
        inventorySetQuantities: { userErrors: UserError[] };
      }>(SET_STOCK, {
        input: {
          name: "available",
          reason: "correction",
          ignoreCompareQuantity: true,
          quantities: stock.map((item) => ({
            inventoryItemId: item.inventoryItemId,
            locationId,
            quantity: item.quantity,
          })),
        },
      });
      if (data.inventorySetQuantities.userErrors.length)
        for (const item of stock)
          results[item.index] = {
            ...results[item.index],
            outcome: "failed",
            message: `Prix mis à jour, stock refusé : ${messages(data.inventorySetQuantities.userErrors)}`,
          };
    }
    return results;
  }

  return { probe, push };
}
