import Stripe from "stripe";
import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "../db";
import { auditEvents, organizations, stripeEvents } from "../db/schema";
import { HttpError } from "../http";
import type { Identity } from "../auth";
import { quotasEnforced } from "./quotas";
import { PLANS, effectivePlanId, type PaidPlanId } from "@/domain/plans";
import { billingEnabled, planForPrice, priceIdFor } from "./config";

export { billingEnabled, planForPrice, priceIdFor };

let client: Stripe | undefined;
export function stripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !billingEnabled())
    throw new HttpError(
      409,
      "Le paiement en ligne n’est pas encore activé. Contactez-nous pour souscrire.",
    );
  client ??= new Stripe(key, {
    appInfo: { name: "CataMotive" },
    maxNetworkRetries: 2,
  });
  return client;
}

function appOrigin() {
  const origin = process.env.APP_ORIGIN;
  if (!origin) throw new Error("APP_ORIGIN manquant.");
  return new URL(origin).origin;
}

async function loadOrganization(organizationId: string) {
  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  if (!organization) throw new HttpError(404, "Organisation introuvable.");
  return organization;
}

async function ensureCustomer(actor: Identity) {
  const organization = await loadOrganization(actor.organizationId);
  if (organization.stripeCustomerId) return organization.stripeCustomerId;
  // The idempotency key prevents two customers for one organization when
  // two checkout requests race within Stripe's 24 h idempotency window.
  const customer = await stripe().customers.create(
    {
      email: actor.email,
      name: organization.name,
      metadata: { organizationId: organization.id },
    },
    { idempotencyKey: `customer:${organization.id}` },
  );
  const [updated] = await db
    .update(organizations)
    .set({ stripeCustomerId: customer.id })
    .where(
      and(
        eq(organizations.id, organization.id),
        isNull(organizations.stripeCustomerId),
      ),
    )
    .returning({ customer: organizations.stripeCustomerId });
  return (
    updated?.customer ??
    (await loadOrganization(organization.id)).stripeCustomerId!
  );
}

/**
 * Returns the URL where the administrator pays. An organization that already
 * holds a paid subscription is sent to the customer portal to change plan,
 * so that it never pays two subscriptions at once.
 */
export async function createCheckout(actor: Identity, plan: PaidPlanId) {
  const organization = await loadOrganization(actor.organizationId);
  if (
    organization.stripeSubscriptionId &&
    effectivePlanId(organization.plan, organization.subscriptionStatus) !==
      "essai"
  )
    return { url: await createPortal(actor), portal: true };
  const customer = await ensureCustomer(actor);
  const origin = appOrigin();
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    client_reference_id: organization.id,
    line_items: [{ price: priceIdFor(plan), quantity: 1 }],
    metadata: { organizationId: organization.id, plan },
    subscription_data: { metadata: { organizationId: organization.id, plan } },
    allow_promotion_codes: true,
    billing_address_collection: "required",
    tax_id_collection: { enabled: true },
    customer_update: { address: "auto", name: "auto" },
    automatic_tax: { enabled: process.env.STRIPE_AUTOMATIC_TAX === "true" },
    locale: "fr",
    success_url: `${origin}/settings?billing=success`,
    cancel_url: `${origin}/settings?billing=cancel`,
  });
  if (!session.url) throw new Error("Session Stripe sans URL.");
  await db.insert(auditEvents).values({
    userId: actor.userId,
    organizationId: actor.organizationId,
    action: "billing.checkout_started",
    entityId: actor.organizationId,
  });
  return { url: session.url, portal: false };
}

/** Stripe customer portal: payment method, invoices, plan change, cancellation. */
export async function createPortal(actor: Identity) {
  const organization = await loadOrganization(actor.organizationId);
  if (!organization.stripeCustomerId)
    throw new HttpError(
      409,
      "Aucun abonnement à gérer pour cette organisation.",
    );
  const session = await stripe().billingPortal.sessions.create({
    customer: organization.stripeCustomerId,
    return_url: `${appOrigin()}/settings`,
    locale: "fr",
  });
  return session.url;
}

export async function verifyWebhook(payload: string, signature: string | null) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(503, "Webhook Stripe non configuré.");
  if (!signature) throw new HttpError(400, "Signature Stripe absente.");
  try {
    return await stripe().webhooks.constructEventAsync(
      payload,
      signature,
      secret,
    );
  } catch {
    throw new HttpError(400, "Signature Stripe invalide.");
  }
}

type SubscriptionState = {
  subscriptionId: string;
  customerId: string;
  organizationId: string | null;
  plan: PaidPlanId;
  status: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
};

export function subscriptionState(
  subscription: Stripe.Subscription,
): SubscriptionState {
  const item = subscription.items.data[0];
  const plan = item ? planForPrice(item.price.id) : null;
  if (!plan)
    throw new Error(
      `Prix Stripe inconnu pour l’abonnement ${subscription.id} : configurez STRIPE_PRICE_*.`,
    );
  return {
    subscriptionId: subscription.id,
    customerId:
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer.id,
    organizationId: subscription.metadata?.organizationId || null,
    plan,
    status: subscription.status,
    currentPeriodEnd: item?.current_period_end
      ? new Date(item.current_period_end * 1000)
      : null,
    cancelAtPeriodEnd:
      subscription.cancel_at_period_end || Boolean(subscription.cancel_at),
  };
}

const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);

function subscriptionIdOf(event: Stripe.Event): string | null {
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    if (session.mode !== "subscription" || !session.subscription) return null;
    return typeof session.subscription === "string"
      ? session.subscription
      : session.subscription.id;
  }
  if (SUBSCRIPTION_EVENTS.has(event.type))
    return (event.data.object as Stripe.Subscription).id;
  return null;
}

/**
 * Applies a verified Stripe event. The subscription is always re-read from
 * Stripe, so events delivered out of order converge on the latest state, and
 * the event id is stored in the same transaction as the change it causes.
 */
export async function handleStripeEvent(
  event: Stripe.Event,
  fetchSubscription: (id: string) => Promise<Stripe.Subscription> = (id) =>
    stripe().subscriptions.retrieve(id),
) {
  const subscriptionId = subscriptionIdOf(event);
  const state = subscriptionId
    ? subscriptionState(await fetchSubscription(subscriptionId))
    : null;
  const referenceId =
    event.type === "checkout.session.completed"
      ? event.data.object.client_reference_id
      : null;
  return applySubscriptionEvent(
    { id: event.id, type: event.type },
    state && { ...state, organizationId: state.organizationId ?? referenceId },
  );
}

export async function applySubscriptionEvent(
  event: { id: string; type: string },
  state: SubscriptionState | null,
) {
  return db.transaction(async (tx) => {
    const [fresh] = await tx
      .insert(stripeEvents)
      .values({ id: event.id, type: event.type })
      .onConflictDoNothing()
      .returning();
    if (!fresh) return "duplicate" as const;
    if (!state) return "ignored" as const;
    const [organization] = await tx
      .select()
      .from(organizations)
      .where(
        or(
          eq(organizations.stripeCustomerId, state.customerId),
          state.organizationId
            ? eq(organizations.id, state.organizationId)
            : undefined,
        ),
      )
      .for("update")
      .limit(1);
    if (!organization) {
      console.error(
        JSON.stringify({
          event: "billing.unknown_customer",
          stripeEvent: event.id,
        }),
      );
      return "ignored" as const;
    }
    const entitled = effectivePlanId(state.plan, state.status) !== "essai";
    // A stale event about an old, ended subscription must not erase the
    // current one (for instance after a resubscription).
    if (
      organization.stripeSubscriptionId &&
      organization.stripeSubscriptionId !== state.subscriptionId &&
      !entitled
    )
      return "ignored" as const;
    const plan = PLANS[effectivePlanId(state.plan, state.status)];
    await tx
      .update(organizations)
      .set({
        plan: state.plan,
        subscriptionStatus: state.status,
        stripeCustomerId: state.customerId,
        stripeSubscriptionId: state.subscriptionId,
        currentPeriodEnd: state.currentPeriodEnd,
        cancelAtPeriodEnd: state.cancelAtPeriodEnd,
        // A downgrade shortens retention to what the new plan allows.
        retentionDays: quotasEnforced()
          ? Math.min(organization.retentionDays, plan.quotas.maxRetentionDays)
          : organization.retentionDays,
      })
      .where(eq(organizations.id, organization.id));
    return "applied" as const;
  });
}
