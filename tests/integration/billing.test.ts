import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Stripe from "stripe";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../../src/server/db";
import {
  auditEvents,
  exportTemplates,
  importJobs,
  mappingTemplates,
  memberships,
  organizations,
  sessions,
  stripeEvents,
  usageRecords,
  users,
} from "../../src/server/db/schema";
import { registerAccount } from "../../src/server/auth";
import { getImport, importCsv } from "../../src/server/imports";
import { LocalFileStore } from "../../src/server/storage";
import { queueImport, runJob, saveMapping } from "../../src/server/catalog";
import { createExport } from "../../src/server/exports";
import { updateOrganization } from "../../src/server/organization";
import {
  assertStorageQuota,
  billingOverview,
  monthlyUsage,
} from "../../src/server/billing/quotas";
import {
  handleStripeEvent,
  verifyWebhook,
} from "../../src/server/billing/stripe";
import { DEFAULT_RULES } from "../../src/domain/catalog";
import { defaultExportConfig } from "../../src/domain/exports";

if (!process.env.DATABASE_URL?.endsWith("/catamotive_test"))
  throw new Error(
    "Les tests d’intégration exigent la base dédiée catamotive_test (.env.test).",
  );

const suffix = randomUUID();
let actor: { userId: string; organizationId: string };
let root: string;
let store: LocalFileStore;
const eventIds: string[] = [];
const identity = () => ({
  ...actor,
  email: `billing-${suffix}@example.test`,
  organizationName: "Organisation facturée",
  role: "admin" as const,
});

function stripeEnv() {
  vi.stubEnv("QUOTAS_ENFORCED", "true");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_catamotive");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_catamotive_test");
  vi.stubEnv("STRIPE_PRICE_STARTER", "price_starter");
  vi.stubEnv("STRIPE_PRICE_PRO", "price_pro");
  vi.stubEnv("STRIPE_PRICE_BUSINESS", "price_business");
}

function subscription(
  id: string,
  price: string,
  status: Stripe.Subscription.Status,
  customer = `cus_${suffix}`,
) {
  return {
    id,
    object: "subscription",
    customer,
    status,
    cancel_at_period_end: false,
    cancel_at: null,
    metadata: { organizationId: actor.organizationId },
    items: {
      data: [
        {
          price: { id: price },
          current_period_end: 1_800_000_000,
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

function event(type: string, object: unknown) {
  const id = `evt_${randomUUID()}`;
  eventIds.push(id);
  return { id, type, data: { object } } as unknown as Stripe.Event;
}

async function importRows(count: number) {
  const body = [
    "ref;nom",
    ...Array.from({ length: count }, (_, i) => `R${i};Pièce ${i}`),
  ].join("\n");
  const id = await importCsv(
    actor,
    "catalogue.csv",
    new Blob([body]).stream(),
    store,
  );
  const imported = await getImport(actor, id);
  await saveMapping(
    actor,
    id,
    { sku: 0, product_name: 1 },
    DEFAULT_RULES,
    imported.job.readOptions,
  );
  return id;
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "drizzle" });
  root = await mkdtemp(join(tmpdir(), "catamotive-billing-"));
  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_DIR = root;
  store = new LocalFileStore(root);
  actor = await registerAccount(
    `billing-${suffix}@example.test`,
    "mot-de-passe-test-uniquement",
    "Organisation facturée",
  );
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  if (actor) {
    const org = actor.organizationId;
    await db.delete(sessions).where(eq(sessions.userId, actor.userId));
    await db.delete(auditEvents).where(eq(auditEvents.organizationId, org));
    await db.delete(importJobs).where(eq(importJobs.organizationId, org));
    await db
      .delete(mappingTemplates)
      .where(eq(mappingTemplates.organizationId, org));
    await db
      .delete(exportTemplates)
      .where(eq(exportTemplates.organizationId, org));
    await db.delete(usageRecords).where(eq(usageRecords.organizationId, org));
    await db.delete(memberships).where(eq(memberships.userId, actor.userId));
    await db.delete(organizations).where(eq(organizations.id, org));
    await db.delete(users).where(eq(users.id, actor.userId));
  }
  if (eventIds.length)
    await db.delete(stripeEvents).where(inArray(stripeEvents.id, eventIds));
  if (root) await rm(root, { recursive: true, force: true });
  await sqlClient.end();
});

describe("quotas par offre et abonnement Stripe", () => {
  it("laisse le pilote sans quota tant que le paiement n'est pas actif", async () => {
    vi.stubEnv("QUOTAS_ENFORCED", "");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const id = await importRows(1_200);
    await expect(queueImport(actor, id)).resolves.toMatchObject({
      queued: true,
    });
    await db.delete(importJobs).where(eq(importJobs.id, id));
  });

  it("applique les limites de l'offre Essai côté serveur", async () => {
    stripeEnv();
    const big = await importRows(1_001);
    await expect(queueImport(actor, big)).rejects.toMatchObject({
      status: 402,
      message: expect.stringMatching(/1\s000 par import/),
    });
    const id = await importRows(1_000);
    await queueImport(actor, id);
    const other = await importRows(1_000);
    await queueImport(actor, other);
    // Queued imports reserve their rows: the next launch would overshoot.
    expect((await monthlyUsage(actor.organizationId)).rows).toBe(2_000);
    const third = await importRows(10);
    await expect(queueImport(actor, third)).rejects.toMatchObject({
      status: 402,
    });
    expect(await runJob(id)).toBe(true);
    expect(await runJob(other)).toBe(true);
    expect((await monthlyUsage(actor.organizationId)).rows).toBe(2_000);

    await expect(
      createExport(actor, id, defaultExportConfig("shopify")),
    ).rejects.toMatchObject({ status: 402 });
    await expect(
      createExport(actor, id, defaultExportConfig("generic"), "Mon modèle"),
    ).rejects.toMatchObject({ status: 402 });
    await expect(
      saveMapping(
        actor,
        third,
        { sku: 0, product_name: 1 },
        DEFAULT_RULES,
        {},
        "Fournisseur",
      ),
    ).rejects.toMatchObject({ status: 402 });
    await expect(
      createExport(actor, id, defaultExportConfig("generic")),
    ).resolves.toMatchObject({ rowCount: 1_000 });

    await expect(
      updateOrganization(identity(), {
        name: "Organisation facturée",
        retentionDays: 90,
      }),
    ).rejects.toMatchObject({ status: 402 });
    await expect(
      assertStorageQuota(actor.organizationId, 100_000_000),
    ).rejects.toMatchObject({
      status: 402,
    });
    await expect(
      assertStorageQuota(actor.organizationId, 1_000),
    ).resolves.toBeUndefined();
  });

  it("active, change puis résilie l'offre au rythme des webhooks, sans double application", async () => {
    stripeEnv();
    const subs = new Map<string, Stripe.Subscription>();
    const fetch = async (id: string) => subs.get(id)!;
    subs.set("sub_1", subscription("sub_1", "price_starter", "active"));
    const checkout = event("checkout.session.completed", {
      mode: "subscription",
      subscription: "sub_1",
      client_reference_id: actor.organizationId,
    });
    expect(await handleStripeEvent(checkout, fetch)).toBe("applied");
    expect(await handleStripeEvent(checkout, fetch)).toBe("duplicate");
    let overview = await billingOverview(actor.organizationId);
    expect(overview.plan.id).toBe("starter");
    expect(overview.currentPeriodEnd?.getTime()).toBe(1_800_000_000_000);

    // Starter now allows CMS profiles, templates and 90 days of retention.
    await updateOrganization(identity(), {
      name: "Organisation facturée",
      retentionDays: 90,
    });
    const id = await importRows(5_000);
    await queueImport(actor, id);
    await runJob(id);
    await expect(
      createExport(actor, id, defaultExportConfig("generic"), "Modèle"),
    ).resolves.toBeTruthy();
    // The CMS profile now passes the plan check and reaches CMS validation.
    await expect(
      createExport(actor, id, defaultExportConfig("shopify")),
    ).rejects.toMatchObject({ status: 422 });

    subs.set("sub_1", subscription("sub_1", "price_pro", "past_due"));
    expect(
      await handleStripeEvent(
        event("customer.subscription.updated", subs.get("sub_1")),
        fetch,
      ),
    ).toBe("applied");
    overview = await billingOverview(actor.organizationId);
    expect(overview.plan.id).toBe("pro");
    expect(overview.status).toBe("past_due");

    // A late event about an older, ended subscription changes nothing.
    subs.set("sub_old", subscription("sub_old", "price_business", "canceled"));
    expect(
      await handleStripeEvent(
        event("customer.subscription.deleted", subs.get("sub_old")),
        fetch,
      ),
    ).toBe("ignored");
    expect((await billingOverview(actor.organizationId)).plan.id).toBe("pro");

    subs.set("sub_1", subscription("sub_1", "price_pro", "canceled"));
    await handleStripeEvent(
      event("customer.subscription.deleted", subs.get("sub_1")),
      fetch,
    );
    overview = await billingOverview(actor.organizationId);
    expect(overview.plan.id).toBe("essai");
    const [organization] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, actor.organizationId));
    expect(organization.retentionDays).toBe(30);
    expect(organization.stripeCustomerId).toBe(`cus_${suffix}`);

    expect(
      await handleStripeEvent(event("invoice.created", { id: "in_1" }), fetch),
    ).toBe("ignored");
  });

  it("refuse un webhook dont la signature est absente ou fausse", async () => {
    stripeEnv();
    const payload = JSON.stringify({
      id: "evt_signed",
      object: "event",
      type: "invoice.created",
      data: { object: {} },
    });
    await expect(verifyWebhook(payload, null)).rejects.toMatchObject({
      status: 400,
    });
    await expect(verifyWebhook(payload, "t=1,v1=faux")).rejects.toMatchObject({
      status: 400,
    });
    const header = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: "whsec_catamotive_test",
    });
    await expect(verifyWebhook(payload, header)).resolves.toMatchObject({
      id: "evt_signed",
    });
  });
});
