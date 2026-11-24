import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PAID_PLAN_IDS,
  PLANS,
  PLAN_IDS,
  effectivePlanId,
  quotaLines,
} from "@/domain/plans";
import { LIMITS } from "@/domain/csv";
import { billingEnabled, planForPrice } from "@/server/billing/config";
import { periodStart, quotasEnforced } from "@/server/billing/quotas";

afterEach(() => vi.unstubAllEnvs());
const stripeEnv = () => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("STRIPE_PRICE_STARTER", "price_starter");
  vi.stubEnv("STRIPE_PRICE_PRO", "price_pro");
  vi.stubEnv("STRIPE_PRICE_BUSINESS", "price_business");
};

describe("offres et quotas", () => {
  it("ordonne des quotas croissants sous les bornes du lecteur", () => {
    for (let i = 1; i < PLAN_IDS.length; i++) {
      const lower = PLANS[PLAN_IDS[i - 1]];
      const upper = PLANS[PLAN_IDS[i]];
      expect(upper.price).toBeGreaterThan(lower.price);
      expect(upper.quotas.rowsPerImport).toBeGreaterThan(
        lower.quotas.rowsPerImport,
      );
      expect(upper.quotas.monthlyRows).toBeGreaterThan(
        lower.quotas.monthlyRows,
      );
      expect(upper.quotas.storageBytes).toBeGreaterThan(
        lower.quotas.storageBytes,
      );
    }
    for (const id of PLAN_IDS)
      expect(PLANS[id].quotas.rowsPerImport).toBeLessThanOrEqual(LIMITS.rows);
    expect(quotaLines(PLANS.business.quotas)).toContain("Exports illimités");
  });

  it("n'accorde l'offre payante qu'avec un statut d'abonnement valide", () => {
    expect(effectivePlanId("pro", "active")).toBe("pro");
    expect(effectivePlanId("pro", "trialing")).toBe("pro");
    expect(effectivePlanId("pro", "past_due")).toBe("pro");
    expect(effectivePlanId("business", "manual")).toBe("business");
    for (const status of [
      "canceled",
      "unpaid",
      "incomplete",
      "incomplete_expired",
      "paused",
      null,
    ])
      expect(effectivePlanId("pro", status)).toBe("essai");
    expect(effectivePlanId("inconnue", "active")).toBe("essai");
    expect(effectivePlanId("essai", "active")).toBe("essai");
  });

  it("relie chaque prix Stripe configuré à une offre", () => {
    expect(billingEnabled()).toBe(false);
    stripeEnv();
    expect(billingEnabled()).toBe(true);
    expect(PAID_PLAN_IDS.map((id) => planForPrice(`price_${id}`))).toEqual([
      ...PAID_PLAN_IDS,
    ]);
    expect(planForPrice("price_autre")).toBeNull();
    vi.stubEnv("STRIPE_PRICE_PRO", "");
    expect(billingEnabled()).toBe(false);
  });

  it("n'applique les quotas qu'avec le paiement actif ou sur demande explicite", () => {
    vi.stubEnv("QUOTAS_ENFORCED", "");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect(quotasEnforced()).toBe(false);
    stripeEnv();
    expect(quotasEnforced()).toBe(true);
    vi.stubEnv("QUOTAS_ENFORCED", "false");
    expect(quotasEnforced()).toBe(false);
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("QUOTAS_ENFORCED", "true");
    expect(quotasEnforced()).toBe(true);
  });

  it("remet les compteurs à zéro le premier du mois en UTC", () => {
    expect(
      periodStart(new Date("2026-11-30T23:30:00-02:00")).toISOString(),
    ).toBe("2026-12-01T00:00:00.000Z");
    expect(periodStart(new Date("2026-11-24T05:00:00Z")).toISOString()).toBe(
      "2026-11-01T00:00:00.000Z",
    );
  });
});
