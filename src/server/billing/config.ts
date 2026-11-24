import { PAID_PLAN_IDS, type PaidPlanId } from "@/domain/plans";

/** Billing settings read from the environment, without database access. */
const PRICE_ENV: Record<PaidPlanId, string> = {
  starter: "STRIPE_PRICE_STARTER",
  pro: "STRIPE_PRICE_PRO",
  business: "STRIPE_PRICE_BUSINESS",
};

export function billingEnabled() {
  return Boolean(
    process.env.STRIPE_SECRET_KEY &&
    PAID_PLAN_IDS.every((plan) => process.env[PRICE_ENV[plan]]),
  );
}

export function priceIdFor(plan: PaidPlanId) {
  const price = process.env[PRICE_ENV[plan]];
  if (!price) throw new Error(`${PRICE_ENV[plan]} manquant.`);
  return price;
}

export function planForPrice(priceId: string): PaidPlanId | null {
  return (
    PAID_PLAN_IDS.find((plan) => process.env[PRICE_ENV[plan]] === priceId) ??
    null
  );
}
