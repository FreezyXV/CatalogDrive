import { describe, expect, it } from "vitest";
import {
  defaultExportConfig,
  exportRecord,
  safeCsvCell,
  shopifyHandle,
  validateExportConfig,
} from "../../src/domain/exports";
describe("profils d’export", () => {
  it("construit les profils WooCommerce, PrestaShop et Shopify", () => {
    for (const profile of ["woocommerce", "prestashop", "shopify"] as const) {
      const config = defaultExportConfig(profile);
      expect(() => validateExportConfig(config)).not.toThrow();
      expect(config.columns.length).toBeGreaterThan(5);
    }
    const woo = exportRecord(
      { sku: "A1", product_name: "Filtre", sale_price: "12.00" },
      { line: 2, confidence: "1" },
      defaultExportConfig("woocommerce"),
    );
    expect(woo).toMatchObject({
      Type: "simple",
      Published: "0",
      SKU: "A1",
      Name: "Filtre",
    });
  });
  it("neutralise les formules CSV et produit un handle Shopify stable", () => {
    expect(safeCsvCell('=HYPERLINK("bad")')).toBe('\'=HYPERLINK("bad")');
    expect(safeCsvCell("  +1")).toBe("'  +1");
    expect(safeCsvCell("Pièce normale")).toBe("Pièce normale");
    expect(shopifyHandle(" Réf Étrange / 01 ")).toBe("cm-ref-etrange-01");
  });
});
