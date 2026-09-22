import Decimal from "decimal.js";
import sanitizeHtml from "sanitize-html";
import {
  type CatalogData,
  type Field,
  type Issue,
  type Mapping,
  type NormalizedRow,
  type RuleConfig,
  RULE_VERSION,
} from "./catalog";

export function validEan(value: string) {
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(value)) return false;
  const digits = [...value].map(Number);
  const check = digits.pop()!;
  return (
    (10 -
      (digits
        .reverse()
        .reduce(
          (sum, digit, index) => sum + digit * (index % 2 === 0 ? 3 : 1),
          0,
        ) %
        10)) %
      10 ===
    check
  );
}
export function decimalValue(raw: string): string | null {
  let value = raw.trim().replace(/[\s\u00a0\u202f]/g, "");
  if (!/^-?[\d.,]+$/.test(value)) return null;
  if (value.includes(",") && value.includes(".")) {
    if (/^-?\d{1,3}(\.\d{3})+,\d{1,2}$/.test(value))
      value = value.replaceAll(".", "").replace(",", ".");
    else if (/^-?\d{1,3}(,\d{3})+\.\d{1,2}$/.test(value))
      value = value.replaceAll(",", "");
    else return null;
  } else value = value.replace(",", ".");
  if (!/^-?\d+(\.\d{1,2})?$/.test(value)) return null;
  const number = new Decimal(value);
  if (!number.isFinite() || number.abs().gt("999999999999.99")) return null;
  return number.toFixed(2);
}
export function normalizeRow(
  values: string[],
  mapping: Mapping,
  config: RuleConfig,
  context: { line: number; at: string; origin: string; headers: string[] },
): NormalizedRow {
  const data: CatalogData = {};
  const transformations: NormalizedRow["transformations"] = [];
  const issues: Issue[] = [];
  const issue = (
    field: Issue["field"],
    code: string,
    message: string,
    severity: Issue["severity"],
    original: string,
    suggestion?: string,
  ) =>
    issues.push({
      id: `${field}:${code}`,
      field,
      code,
      message,
      severity,
      original,
      ...(suggestion !== undefined ? { suggestion } : {}),
    });
  const change = (field: Field, next: string, rule: string) => {
    const original = data[field] ?? "";
    if (original !== next) {
      transformations.push({
        field,
        original,
        value: next,
        rule,
        version: RULE_VERSION,
        at: context.at,
        origin: context.origin,
      });
      data[field] = next;
    }
  };
  if (values.every((value) => !value.trim()))
    issue("_row", "empty_row", "Ligne vide : excluez-la.", "error", "");
  if (values.length !== context.headers.length)
    issue(
      "_row",
      "column_count",
      "La ligne ne possède pas le même nombre de colonnes que l’en-tête. Vérifiez les données brutes.",
      "warning",
      values.join(" | "),
    );
  for (const [field, index] of Object.entries(mapping) as [Field, number][]) {
    data[field] = values[index] ?? "";
    // Automotive evidence is preserved exactly, without inferred fitment or dates.
    if (field.endsWith("_raw")) continue;
    change(field, data[field]!.trim(), "trim_whitespace");
    if (
      /^[=+@]/.test(data[field]!) &&
      !["purchase_price", "sale_price", "stock_quantity", "tax_rate"].includes(
        field,
      )
    )
      issue(
        field,
        "formula",
        "Valeur ressemblant à une formule : vérification nécessaire. Aucune formule n’est exécutée.",
        "warning",
        data[field]!,
      );
    if (
      [
        "sku",
        "supplier_reference",
        "oem_reference",
        "manufacturer_reference",
      ].includes(field) &&
      config.stripReferenceSeparators
    ) {
      const normalized = data[field]!.replace(/[\s.\-/]+/g, "").toUpperCase();
      if (normalized !== data[field])
        issue(
          field,
          "reference_format",
          "Vérifiez la référence sans espaces ni séparateurs.",
          "warning",
          data[field]!,
          normalized,
        );
    }
    if (["product_name", "description"].includes(field)) {
      change(
        field,
        sanitizeHtml(data[field]!, {
          allowedTags: [],
          allowedAttributes: {},
          nonTextTags: ["script", "style", "textarea", "option"],
        }),
        "remove_html",
      );
      change(
        field,
        data[field]!.replace(/[^\S\n]+/g, " ").trim(),
        "collapse_whitespace",
      );
    }
    if (field === "brand" && data.brand && config.normalizeBrands) {
      change(field, data.brand.toUpperCase(), "brand_case");
      const alias = Object.entries(config.brandAliases).find(
        ([key]) => key.trim().toUpperCase() === data.brand,
      );
      if (alias) change(field, alias[1].trim().toUpperCase(), "brand_alias");
    }
    if (field === "ean" && data.ean) {
      change(field, data.ean.replace(/\s/g, ""), "ean_whitespace");
      if (!validEan(data.ean!))
        issue(
          field,
          "ean_checksum",
          "EAN/GTIN invalide : longueur ou clé de contrôle incorrecte.",
          "error",
          data.ean!,
        );
    }
    if (
      ["purchase_price", "sale_price", "tax_rate"].includes(field) &&
      data[field]
    ) {
      const parsed = decimalValue(data[field]!);
      if (parsed === null)
        issue(
          field,
          "decimal_ambiguous",
          "Montant ambigu. Saisissez une valeur numérique avec au plus deux décimales.",
          "error",
          data[field]!,
        );
      else {
        change(field, parsed, "decimal_format");
        if (new Decimal(parsed).lt(0))
          issue(
            field,
            "negative_amount",
            "Une valeur négative n’est pas autorisée.",
            "error",
            parsed,
          );
        if (field === "tax_rate" && new Decimal(parsed).gt(100))
          issue(
            field,
            "tax_range",
            "Le taux de TVA doit être compris entre 0 et 100.",
            "error",
            parsed,
          );
      }
    }
    if (field === "stock_quantity" && data.stock_quantity) {
      const stock = data.stock_quantity
        .replace(/\s/g, "")
        .replace(/[,\.]0+$/, "");
      if (!/^\d{1,9}$/.test(stock))
        issue(
          field,
          "stock_invalid",
          "Le stock doit être un entier positif ou nul, inférieur à un milliard.",
          "error",
          data.stock_quantity,
        );
      else change(field, String(Number(stock)), "stock_integer");
    }
    if (field === "currency" && data.currency) {
      const currency =
        (
          {
            "€": "EUR",
            $: "USD",
            "£": "GBP",
            EURO: "EUR",
            EUROS: "EUR",
          } as Record<string, string>
        )[data.currency.toUpperCase()] ?? data.currency.toUpperCase();
      change(field, currency, "currency_code");
      if (
        !/^[A-Z]{3}$/.test(currency) ||
        ![
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
        ].includes(currency)
      )
        issue(
          field,
          "currency_invalid",
          "Devise non prise en charge. Utilisez un code ISO proposé dans le mapping.",
          "error",
          currency,
        );
    }
    if (field === "condition" && data.condition) {
      const condition =
        (
          {
            neuf: "new",
            nouveau: "new",
            occasion: "used",
            reconditionne: "refurbished",
            reconditionné: "refurbished",
          } as Record<string, string>
        )[data.condition.toLowerCase()] ?? data.condition.toLowerCase();
      change(field, condition, "condition_alias");
      if (!["new", "used", "refurbished"].includes(condition))
        issue(
          field,
          "condition_unknown",
          "État inconnu : new, used ou refurbished attendu.",
          "warning",
          condition,
        );
    }
    if (field === "image_urls" && data.image_urls) {
      const urls = data.image_urls.split(/\s*[|;\n]\s*/).filter(Boolean);
      if (
        urls.some((url) => {
          try {
            const parsed = new URL(url);
            return (
              !["https:", "http:"].includes(parsed.protocol) ||
              !!parsed.username ||
              !!parsed.password
            );
          } catch {
            return true;
          }
        })
      )
        issue(
          field,
          "image_url",
          "URL d’image invalide. Seules les URLs HTTP(S) sans identifiants sont acceptées.",
          "error",
          data.image_urls,
        );
      else change(field, urls.join(" | "), "image_url_list");
    }
  }
  if (!data.sku && data.supplier_reference)
    change("sku", data.supplier_reference, "sku_from_supplier");
  if (!data.currency)
    change("currency", config.defaultCurrency, "configured_currency");
  for (const field of config.required)
    if (!data[field]?.trim())
      issue(
        field,
        "required",
        `${field} : valeur obligatoire manquante.`,
        "error",
        "",
      );
  if (
    data.purchase_price &&
    data.sale_price &&
    decimalValue(data.purchase_price) &&
    decimalValue(data.sale_price) &&
    new Decimal(data.sale_price).lt(data.purchase_price)
  )
    issue(
      "sale_price",
      "below_cost",
      "Le prix de vente est inférieur au prix d’achat. Confirmez cette décision commerciale.",
      "warning",
      data.sale_price,
    );
  return {
    data,
    transformations,
    issues,
    status: statusFor(issues),
    confidence: issues.some((i) => i.severity === "error")
      ? 0
      : issues.length
        ? 0.6
        : 1,
  };
}
export const statusFor = (issues: Issue[]) =>
  issues.some((i) => i.severity === "error")
    ? ("invalid" as const)
    : issues.length
      ? ("ambiguous" as const)
      : ("valid" as const);
export function similarity(a: string, b: string) {
  const grams = (value: string) => {
    const text = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    return new Set(
      Array.from({ length: Math.max(0, text.length - 1) }, (_, i) =>
        text.slice(i, i + 2),
      ),
    );
  };
  const left = grams(a),
    right = grams(b);
  if (!left.size || !right.size) return a === b ? 1 : 0;
  return (
    (2 * [...left].filter((gram) => right.has(gram)).length) /
    (left.size + right.size)
  );
}
