/**
 * Commercial offers and their server-side quotas.
 *
 * Prices are monthly, excluding VAT. The numbers below are the first
 * commercial hypothesis (see docs/COMMERCIALISATION.md): change them here,
 * the Pricing page, the settings page and the server checks follow.
 */
export const PLAN_IDS = ["essai", "starter", "pro", "business"] as const;
export type PlanId = (typeof PLAN_IDS)[number];
export type PaidPlanId = Exclude<PlanId, "essai">;

export type PlanQuotas = {
  /** Data rows accepted in one import (the file parser stops at 500 000). */
  rowsPerImport: number;
  /** Rows processed per calendar month (UTC), queued imports included. */
  monthlyRows: number;
  /** Exports per calendar month (UTC); null means unlimited. */
  monthlyExports: number | null;
  /** Source files kept at the same time (uploads and ZIP archives). */
  storageBytes: number;
  /** WooCommerce, PrestaShop and Shopify export profiles. */
  cmsProfiles: boolean;
  /** Saved mapping and export templates. */
  templates: boolean;
  /** Longest retention an organization can choose. */
  maxRetentionDays: number;
};

export type Plan = {
  id: PlanId;
  name: string;
  /** Monthly price in euros, excluding VAT. */
  price: number;
  text: string;
  features: string[];
  quotas: PlanQuotas;
};

const MB = 1_000_000;
const GB = 1_000 * MB;

export const PLANS: Record<PlanId, Plan> = {
  essai: {
    id: "essai",
    name: "Essai",
    price: 0,
    text: "Découvrir le parcours avec un petit catalogue.",
    features: ["Compte et organisation", "Export générique"],
    quotas: {
      rowsPerImport: 1_000,
      monthlyRows: 2_000,
      monthlyExports: 10,
      storageBytes: 100 * MB,
      cmsProfiles: false,
      templates: false,
      maxRetentionDays: 30,
    },
  },
  starter: {
    id: "starter",
    name: "Starter",
    price: 59,
    text: "Pour un revendeur indépendant.",
    features: ["Imports récurrents", "Profils CMS", "Modèles fournisseurs"],
    quotas: {
      rowsPerImport: 20_000,
      monthlyRows: 100_000,
      monthlyExports: 200,
      storageBytes: 2 * GB,
      cmsProfiles: true,
      templates: true,
      maxRetentionDays: 90,
    },
  },
  pro: {
    id: "pro",
    name: "Pro",
    price: 199,
    text: "Pour une équipe catalogue active.",
    features: [
      "Volumes supérieurs",
      "Historique complet",
      "Support prioritaire",
    ],
    quotas: {
      rowsPerImport: 100_000,
      monthlyRows: 1_000_000,
      monthlyExports: 2_000,
      storageBytes: 20 * GB,
      cmsProfiles: true,
      templates: true,
      maxRetentionDays: 365,
    },
  },
  business: {
    id: "business",
    name: "Business",
    price: 499,
    text: "Pour plusieurs catalogues ou clients.",
    features: ["Usage étendu", "Gouvernance renforcée", "Accompagnement"],
    quotas: {
      rowsPerImport: 500_000,
      monthlyRows: 5_000_000,
      monthlyExports: null,
      storageBytes: 100 * GB,
      cmsProfiles: true,
      templates: true,
      maxRetentionDays: 365,
    },
  },
};

export const PAID_PLAN_IDS = [
  "starter",
  "pro",
  "business",
] as const satisfies readonly PaidPlanId[];

export function isPlanId(value: unknown): value is PlanId {
  return (PLAN_IDS as readonly unknown[]).includes(value);
}

export function isPaidPlanId(value: unknown): value is PaidPlanId {
  return isPlanId(value) && value !== "essai";
}

/**
 * Subscription statuses that grant the paid plan. `past_due` keeps access
 * while Stripe retries the payment (grace period configured in Stripe);
 * `manual` is set by hand for an invoiced customer without Stripe.
 */
export const ENTITLED_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "manual",
] as const;

export function effectivePlanId(
  plan: string | null | undefined,
  status: string | null | undefined,
): PlanId {
  if (!isPaidPlanId(plan)) return "essai";
  return (ENTITLED_STATUSES as readonly string[]).includes(status ?? "")
    ? plan
    : "essai";
}

export function formatQuota(value: number | null, unit = "") {
  if (value === null) return "Illimité";
  return `${value.toLocaleString("fr-FR")}${unit ? ` ${unit}` : ""}`;
}

export function formatBytes(bytes: number) {
  if (bytes >= GB)
    return `${(bytes / GB).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Go`;
  return `${(bytes / MB).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`;
}

export function quotaLines(quotas: PlanQuotas) {
  return [
    `${formatQuota(quotas.rowsPerImport)} lignes par import`,
    `${formatQuota(quotas.monthlyRows)} lignes traitées par mois`,
    quotas.monthlyExports === null
      ? "Exports illimités"
      : `${formatQuota(quotas.monthlyExports)} exports par mois`,
    `${formatBytes(quotas.storageBytes)} de fichiers conservés`,
    `Conservation jusqu’à ${quotas.maxRetentionDays} jours`,
  ];
}
