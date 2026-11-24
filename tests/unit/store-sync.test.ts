import { describe, expect, it } from "vitest";
import {
  normalizeShopifyDomain,
  normalizeWooUrl,
  priceBasisMismatch,
  storeRowErrors,
  toStoreProduct,
  type StoreProduct,
} from "../../src/domain/store-sync";
import { decryptSecret, encryptSecret } from "../../src/server/stores/crypto";
import {
  assertPublicHost,
  isPrivateAddress,
  storeFetch,
  type Transport,
} from "../../src/server/stores/network";
import { shopifyClient } from "../../src/server/stores/shopify";
import { wooClient } from "../../src/server/stores/woocommerce";

type Call = { url: string; body: unknown; headers: Record<string, string> };
/** Scripted transport: answers in order, records every request. */
function scripted(responses: (Response | (() => Response))[]) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const transport: Transport = {
    async fetch(url, init) {
      calls.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: init?.headers as Record<string, string>,
      });
      const next = responses.shift();
      if (!next) throw new Error(`Appel inattendu : ${url}`);
      return typeof next === "function" ? next() : next;
    },
    async sleep(ms) {
      sleeps.push(ms);
    },
  };
  return { transport, calls, sleeps };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const product = (overrides: Partial<StoreProduct> = {}): StoreProduct => ({
  line: 2,
  sku: "FLT-1",
  title: "Filtre à huile",
  descriptionHtml: "Pour moteur diesel",
  price: "12.50",
  stock: 4,
  vendor: "BOSCH",
  productType: "Filtration",
  barcode: "4006633000127",
  oemReference: "OEM-9",
  images: ["https://cdn.example.com/a.jpg"],
  ...overrides,
});

describe("adresses de boutique", () => {
  it("normalise un domaine Shopify et refuse un domaine tiers", () => {
    expect(normalizeShopifyDomain("Ma-Boutique")).toBe(
      "ma-boutique.myshopify.com",
    );
    expect(
      normalizeShopifyDomain(
        "https://ma-boutique.myshopify.com/admin/products",
      ),
    ).toBe("ma-boutique.myshopify.com");
    expect(() => normalizeShopifyDomain("evil.example.com")).toThrow();
    expect(() =>
      normalizeShopifyDomain("x.myshopify.com.evil.example"),
    ).toThrow();
  });
  it("exige une URL WooCommerce HTTPS publique sans identifiants", () => {
    expect(normalizeWooUrl("https://Shop.Example.fr/boutique/wp-json/")).toBe(
      "https://shop.example.fr/boutique",
    );
    for (const url of [
      "http://shop.example.fr",
      "https://user:pass@shop.example.fr",
      "https://shop.example.fr:8443",
      "https://127.0.0.1",
      "https://localhost",
      "https://shop.example.fr/?a=1",
    ])
      expect(() => normalizeWooUrl(url), url).toThrow();
  });
  it("refuse les hôtes qui résolvent vers une adresse privée", async () => {
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    const resolver = (address: string) =>
      (async () => [{ address, family: 4 }]) as never;
    await expect(
      assertPublicHost("shop.example.fr", resolver("127.0.0.1")),
    ).rejects.toThrow(/non publique/);
    await expect(
      assertPublicHost("shop.example.fr", resolver("93.184.216.34")),
    ).resolves.toBeUndefined();
  });
});

describe("chiffrement des clés", () => {
  it("déchiffre avec le bon contexte et refuse un secret déplacé", () => {
    process.env.STORE_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString("base64");
    const sealed = encryptSecret("shpat_secret", "connexion-a");
    expect(sealed).not.toContain("shpat");
    expect(decryptSecret(sealed, "connexion-a")).toBe("shpat_secret");
    expect(() => decryptSecret(sealed, "connexion-b")).toThrow();
  });
});

describe("règles d’envoi", () => {
  it("projette le modèle pivot et échappe la description", () => {
    expect(
      toStoreProduct(
        {
          sku: "A1",
          product_name: "Disque",
          description: "Ligne 1\n<b>2</b>",
          sale_price: "30.00",
          stock_quantity: "7",
          image_urls: "https://a.example/1.jpg | https://a.example/2.jpg",
        },
        9,
      ),
    ).toMatchObject({
      line: 9,
      descriptionHtml: "Ligne 1<br>&lt;b&gt;2&lt;/b&gt;",
      stock: 7,
      images: ["https://a.example/1.jpg", "https://a.example/2.jpg"],
    });
  });
  it("bloque une convention HT/TTC différente et une autre devise", () => {
    const store = { name: "S", currency: "EUR", pricesIncludeTax: true };
    expect(priceBasisMismatch("incl_tax", store)).toBeNull();
    expect(priceBasisMismatch("excl_tax", store)).toMatch(/TTC/);
    expect(storeRowErrors({ currency: "USD" }, store, "EUR")).toHaveLength(1);
    expect(storeRowErrors({}, store, "EUR")).toHaveLength(0);
  });
});

describe("appels HTTP", () => {
  it("réessaie après un 429 en respectant Retry-After", async () => {
    const { transport, sleeps } = scripted([
      new Response("", { status: 429, headers: { "Retry-After": "2" } }),
      json({ ok: true }),
    ]);
    const response = await storeFetch(transport, "https://x.example", {});
    expect(response.status).toBe(200);
    expect(sleeps).toEqual([2000]);
  });
  it("refuse une redirection", async () => {
    const { transport } = scripted([
      new Response("", {
        status: 301,
        headers: { Location: "http://10.0.0.1" },
      }),
    ]);
    await expect(
      storeFetch(transport, "https://x.example", {}),
    ).rejects.toThrow(/redirection/);
  });
});

const shopInfo = () =>
  json({
    data: {
      shop: { name: "Démo", currencyCode: "EUR", taxesIncluded: true },
      location: { id: "gid://shopify/Location/1" },
    },
  });

describe("adaptateur Shopify", () => {
  it("crée un produit absent en brouillon avec stock et images", async () => {
    const { transport, calls } = scripted([
      shopInfo,
      json({ data: { productVariants: { nodes: [] } } }),
      json({
        data: {
          productSet: {
            product: { id: "gid://shopify/Product/1" },
            userErrors: [],
          },
        },
      }),
    ]);
    const client = shopifyClient("demo.myshopify.com", "shpat_x", transport);
    const results = await client.push([product()], {
      updateMode: "all",
      dryRun: false,
    });
    expect(results).toEqual([{ line: 2, sku: "FLT-1", outcome: "created" }]);
    expect(calls[0].url).toBe(
      "https://demo.myshopify.com/admin/api/2025-10/graphql.json",
    );
    expect(calls[0].headers["X-Shopify-Access-Token"]).toBe("shpat_x");
    expect(calls[1].body).toMatchObject({
      variables: { q: 'sku:"FLT-1"' },
    });
    const input = (calls[2].body as { variables: { input: never } }).variables
      .input;
    expect(input).toMatchObject({
      status: "DRAFT",
      handle: "cm-flt-1",
      variants: [
        {
          price: "12.50",
          inventoryItem: { sku: "FLT-1", tracked: true },
          inventoryQuantities: [
            { locationId: "gid://shopify/Location/1", quantity: 4 },
          ],
        },
      ],
      files: [{ originalSource: "https://cdn.example.com/a.jpg" }],
    });
  });

  it("met à jour prix et stock sans toucher la fiche, ignore les variantes", async () => {
    const variant = (sku: string, count: number, n: number) => ({
      id: `gid://shopify/ProductVariant/${n}`,
      sku,
      inventoryItem: { id: `gid://shopify/InventoryItem/${n}`, tracked: true },
      product: {
        id: `gid://shopify/Product/${n}`,
        variantsCount: { count },
      },
    });
    const { transport, calls } = scripted([
      shopInfo,
      json({
        data: {
          productVariants: {
            nodes: [variant("FLT-1", 1, 1), variant("MULTI", 3, 2)],
          },
        },
      }),
      json({ data: { productVariantsBulkUpdate: { userErrors: [] } } }),
      json({ data: { inventorySetQuantities: { userErrors: [] } } }),
    ]);
    const client = shopifyClient("demo.myshopify.com", "shpat_x", transport);
    const results = await client.push(
      [product(), product({ line: 3, sku: "MULTI" })],
      { updateMode: "price_stock", dryRun: false },
    );
    expect(results.map((r) => r.outcome)).toEqual(["updated", "skipped"]);
    expect(calls).toHaveLength(4);
    expect(JSON.stringify(calls.map((c) => c.body))).not.toContain(
      "productUpdate(",
    );
    expect(calls[2].body).toMatchObject({
      variables: {
        variants: [{ id: "gid://shopify/ProductVariant/1", price: "12.50" }],
      },
    });
    expect(calls[3].body).toMatchObject({
      variables: {
        input: {
          quantities: [
            {
              inventoryItemId: "gid://shopify/InventoryItem/1",
              quantity: 4,
            },
          ],
        },
      },
    });
  });

  it("attend puis réessaie quand Shopify limite le débit", async () => {
    const { transport, sleeps } = scripted([
      json({
        errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
      }),
      shopInfo,
    ]);
    const info = await shopifyClient(
      "demo.myshopify.com",
      "shpat_x",
      transport,
    ).probe();
    expect(info).toEqual({
      name: "Démo",
      currency: "EUR",
      pricesIncludeTax: true,
    });
    expect(sleeps).toEqual([2000]);
  });

  it("n’écrit rien en simulation", async () => {
    const { transport, calls } = scripted([
      shopInfo,
      json({ data: { productVariants: { nodes: [] } } }),
    ]);
    const results = await shopifyClient(
      "demo.myshopify.com",
      "shpat_x",
      transport,
    ).push([product()], { updateMode: "all", dryRun: true });
    expect(results[0].outcome).toBe("created");
    expect(calls).toHaveLength(2);
  });
});

describe("adaptateur WooCommerce", () => {
  it("lit devise et convention de prix", async () => {
    const { transport, calls } = scripted([
      json({ value: "EUR" }),
      json({ value: "no" }),
    ]);
    const info = await wooClient(
      "https://shop.example.fr",
      "ck_a",
      "cs_b",
      transport,
    ).probe();
    expect(info).toEqual({
      name: "shop.example.fr",
      currency: "EUR",
      pricesIncludeTax: false,
    });
    expect(calls[0].headers.Authorization).toBe(
      `Basic ${Buffer.from("ck_a:cs_b").toString("base64")}`,
    );
  });

  it("crée, met à jour et rapporte les erreurs ligne par ligne", async () => {
    const { transport, calls } = scripted([
      json([
        { id: 11, sku: "OLD", type: "simple" },
        { id: 12, sku: "VAR", type: "variable" },
      ]),
      json({
        create: [
          { id: 20, sku: "FLT-1" },
          { id: 0, error: { code: "invalid", message: "SKU déjà utilisé." } },
        ],
        update: [{ id: 11, sku: "OLD" }],
      }),
    ]);
    const results = await wooClient(
      "https://shop.example.fr",
      "ck_a",
      "cs_b",
      transport,
    ).push(
      [
        product(),
        product({ line: 3, sku: "OLD" }),
        product({ line: 4, sku: "VAR" }),
        product({ line: 5, sku: "DUP" }),
        product({ line: 6, sku: "A,B" }),
      ],
      { updateMode: "price_stock", dryRun: false },
    );
    expect(results.map((r) => [r.line, r.outcome])).toEqual([
      [2, "created"],
      [3, "updated"],
      [4, "skipped"],
      [5, "failed"],
      [6, "skipped"],
    ]);
    expect(results[3].message).toBe("SKU déjà utilisé.");
    const lookup = new URL(calls[0].url);
    expect(lookup.pathname).toBe("/wp-json/wc/v3/products");
    expect(lookup.searchParams.get("sku")).toBe("FLT-1,OLD,VAR,DUP");
    const batch = calls[1].body as {
      create: Record<string, unknown>[];
      update: Record<string, unknown>[];
    };
    expect(batch.create[0]).toMatchObject({
      status: "draft",
      type: "simple",
      sku: "FLT-1",
      regular_price: "12.50",
      manage_stock: true,
      stock_quantity: 4,
      images: [{ src: "https://cdn.example.com/a.jpg" }],
    });
    expect(batch.update[0]).toEqual({
      id: 11,
      regular_price: "12.50",
      manage_stock: true,
      stock_quantity: 4,
    });
  });
});
