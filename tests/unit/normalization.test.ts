import { describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "../../src/domain/catalog";
import {
  decimalValue,
  normalizeRow,
  similarity,
  validEan,
} from "../../src/domain/normalization";

describe("moteur déterministe de normalisation", () => {
  it("applique et trace plus de dix règles sans inventer les données automobiles", () => {
    const values = [
      " A 123-45 ",
      " <b>  Filtre   à huile </b><script>x</script> ",
      "bosch",
      "1.234,50",
      "12,0",
      "€",
      "009,00",
      "neuf",
      "https://a.test/1.jpg; https://a.test/2.jpg",
      "4006381333931",
      "Golf 2.0 TDI ",
    ];
    const result = normalizeRow(
      values,
      {
        supplier_reference: 0,
        product_name: 1,
        brand: 2,
        sale_price: 3,
        tax_rate: 4,
        currency: 5,
        stock_quantity: 6,
        condition: 7,
        image_urls: 8,
        ean: 9,
        vehicle_information_raw: 10,
      },
      { ...DEFAULT_RULES, brandAliases: { BOSCH: "Robert Bosch" } },
      {
        line: 2,
        headers: values.map((_, i) => `c${i}`),
        at: "2026-09-22T00:00:00.000Z",
        origin: "test.xlsx:Catalogue:2",
      },
    );
    expect(result.data).toMatchObject({
      supplier_reference: "A 123-45",
      sku: "A 123-45",
      product_name: "Filtre à huile",
      brand: "ROBERT BOSCH",
      sale_price: "1234.50",
      tax_rate: "12.00",
      currency: "EUR",
      stock_quantity: "9",
      condition: "new",
      image_urls: "https://a.test/1.jpg | https://a.test/2.jpg",
      ean: "4006381333931",
      vehicle_information_raw: "Golf 2.0 TDI ",
    });
    expect(
      result.issues.find((issue) => issue.code === "reference_format")
        ?.suggestion,
    ).toBe("A12345");
    expect(
      new Set(result.transformations.map((item) => item.rule)).size,
    ).toBeGreaterThanOrEqual(10);
    expect(
      result.transformations.every(
        (item) => item.version && item.at && item.origin,
      ),
    ).toBe(true);
  });

  it("classe les erreurs, avertissements et données saines", () => {
    const context = {
      line: 2,
      headers: ["sku", "nom", "ean", "pa", "pv"],
      at: "2026-09-22T00:00:00Z",
      origin: "test",
    };
    const invalid = normalizeRow(
      ["", "", "123", "10", "-2"],
      { sku: 0, product_name: 1, ean: 2, purchase_price: 3, sale_price: 4 },
      DEFAULT_RULES,
      context,
    );
    expect(invalid.status).toBe("invalid");
    expect(invalid.issues.map((item) => item.code)).toEqual(
      expect.arrayContaining(["ean_checksum", "negative_amount", "required"]),
    );
    const ambiguous = normalizeRow(
      ["A-1", "Produit", "", "10", "9"],
      { sku: 0, product_name: 1, ean: 2, purchase_price: 3, sale_price: 4 },
      DEFAULT_RULES,
      context,
    );
    expect(ambiguous.status).toBe("ambiguous");
    expect(ambiguous.issues.map((item) => item.code)).toEqual(
      expect.arrayContaining(["reference_format", "below_cost"]),
    );
    const valid = normalizeRow(
      ["A1", "Produit", "", "10", "12"],
      { sku: 0, product_name: 1, ean: 2, purchase_price: 3, sale_price: 4 },
      DEFAULT_RULES,
      context,
    );
    expect(valid.status).toBe("valid");
  });

  it("valide les EAN, les nombres localisés et le score de proximité", () => {
    expect(validEan("4006381333931")).toBe(true);
    expect(validEan("4006381333932")).toBe(false);
    expect(decimalValue("1 234,56")).toBe("1234.56");
    expect(decimalValue("1,234.56")).toBe("1234.56");
    expect(decimalValue("1,2,3")).toBeNull();
    expect(similarity("ABC-1234", "ABC1235")).toBeGreaterThan(0.7);
  });
});
