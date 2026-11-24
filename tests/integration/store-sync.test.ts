import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

// Store hosts are fictitious: answer the anti-SSRF lookup with a public IP.
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));

const { db, sqlClient } = await import("../../src/server/db");
const schema = await import("../../src/server/db/schema");
const { registerAccount } = await import("../../src/server/auth");
const { importCsv, getImport } = await import("../../src/server/imports");
const { saveMapping, queueImport, runJob } =
  await import("../../src/server/catalog");
const { LocalFileStore } = await import("../../src/server/storage");
const { DEFAULT_RULES } = await import("../../src/domain/catalog");
const { encryptSecret } = await import("../../src/server/stores/crypto");
const { startSync, advanceSync, getSync, resumeSync } =
  await import("../../src/server/stores/sync");
import type { Transport } from "../../src/server/stores/network";

if (!process.env.DATABASE_URL?.endsWith("/catamotive_test"))
  throw new Error(
    "Les tests d’intégration exigent la base dédiée catamotive_test (.env.test).",
  );

let actor: { userId: string; organizationId: string };
let root: string;
let importId: string;
let connectionId: string;

/** Minimal WooCommerce double: empty catalogue, every create succeeds. */
function fakeWoo(pricesIncludeTax = false) {
  const created: string[] = [];
  const transport: Transport = {
    async sleep() {},
    async fetch(url, init) {
      const path = new URL(url).pathname;
      const reply = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200 });
      if (path.endsWith("woocommerce_currency")) return reply({ value: "EUR" });
      if (path.endsWith("woocommerce_prices_include_tax"))
        return reply({ value: pricesIncludeTax ? "yes" : "no" });
      if (path.endsWith("/products") && init?.method !== "POST")
        return reply([]);
      if (path.endsWith("/products/batch")) {
        const body = JSON.parse(String(init!.body)) as {
          create: { sku: string }[];
        };
        created.push(...body.create.map((item) => item.sku));
        return reply({
          create: body.create.map((item, index) => ({
            id: index + 1,
            sku: item.sku,
          })),
          update: [],
        });
      }
      throw new Error(`Appel inattendu ${path}`);
    },
  };
  return { transport, created };
}

beforeAll(async () => {
  process.env.STORE_CREDENTIALS_KEY = Buffer.alloc(32, 3).toString("base64");
  await migrate(db, { migrationsFolder: "drizzle" });
  root = await mkdtemp(join(tmpdir(), "catamotive-store-"));
  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_DIR = root;
  const store = new LocalFileStore(root);
  actor = await registerAccount(
    `store-${randomUUID()}@example.test`,
    "mot-de-passe-test-uniquement",
    "Organisation boutique",
  );
  const lines = ["sku;nom;prix;stock;devise"];
  for (let i = 1; i <= 120; i++)
    lines.push(`P${String(i).padStart(3, "0")};Pièce ${i};12.50;3;EUR`);
  lines.push("P001;Doublon;9.00;1;EUR");
  lines.push("PUSD;Pièce en dollars;10.00;1;USD");
  importId = await importCsv(
    actor,
    "catalogue.csv",
    new Blob([lines.join("\n") + "\n"]).stream(),
    store,
  );
  const imported = await getImport(actor, importId);
  await saveMapping(
    actor,
    importId,
    {
      sku: 0,
      product_name: 1,
      sale_price: 2,
      stock_quantity: 3,
      currency: 4,
    },
    { ...DEFAULT_RULES, fuzzyDuplicates: false },
    imported.job.readOptions,
  );
  await queueImport(actor, importId);
  await runJob(importId);
  // A reviewer kept the duplicate (flagged "ambiguous"): the store sync must
  // still send that SKU only once.
  await db
    .update(schema.processedRows)
    .set({ status: "valid" })
    .where(
      sql`${schema.processedRows.importId} = ${importId} AND ${schema.processedRows.data}->>'product_name' = 'Doublon'`,
    );
  connectionId = randomUUID();
  await db.insert(schema.storeConnections).values({
    id: connectionId,
    organizationId: actor.organizationId,
    platform: "woocommerce",
    label: "Boutique test",
    address: "https://shop.example.fr",
    credentials: encryptSecret(
      JSON.stringify({
        platform: "woocommerce",
        consumerKey: "ck_test",
        consumerSecret: "cs_test",
      }),
      connectionId,
    ),
    secretHint: "…test",
    createdBy: actor.userId,
  });
});

afterAll(async () => {
  if (actor) {
    const org = actor.organizationId;
    await db
      .delete(schema.sessions)
      .where(eq(schema.sessions.userId, actor.userId));
    await db
      .delete(schema.auditEvents)
      .where(eq(schema.auditEvents.organizationId, org));
    await db
      .delete(schema.importJobs)
      .where(eq(schema.importJobs.organizationId, org));
    await db
      .delete(schema.mappingTemplates)
      .where(eq(schema.mappingTemplates.organizationId, org));
    await db
      .delete(schema.usageRecords)
      .where(eq(schema.usageRecords.organizationId, org));
    await db
      .delete(schema.storeConnections)
      .where(eq(schema.storeConnections.organizationId, org));
    await db
      .delete(schema.memberships)
      .where(eq(schema.memberships.userId, actor.userId));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, org));
    await db.delete(schema.users).where(eq(schema.users.id, actor.userId));
  }
  if (root) await rm(root, { recursive: true, force: true });
  await sqlClient.end();
});

describe("envoi direct vers une boutique (PostgreSQL réel)", () => {
  it("refuse avant toute écriture une boutique en TTC pour une source HT", async () => {
    const sync = await startSync(actor, importId, {
      connectionId,
      updateMode: "all",
      dryRun: false,
    });
    const woo = fakeWoo(true);
    await advanceSync(sync.id, Date.now() + 60_000, woo.transport);
    const failed = await getSync(actor, sync.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/TTC/);
    expect(woo.created).toHaveLength(0);
  });

  it("envoie par lots, reprend après la pause et filtre doublons et devises", async () => {
    const [previous] = await db
      .select({ id: schema.storeSyncs.id })
      .from(schema.storeSyncs)
      .where(eq(schema.storeSyncs.importId, importId));
    // A failed sync can be resumed; delete it here to start from scratch.
    await db
      .delete(schema.storeSyncs)
      .where(eq(schema.storeSyncs.id, previous.id));
    const sync = await startSync(actor, importId, {
      connectionId,
      updateMode: "all",
      dryRun: false,
    });
    expect(sync.total).toBe(122);
    await expect(
      startSync(actor, importId, {
        connectionId,
        updateMode: "all",
        dryRun: false,
      }),
    ).rejects.toThrow(/déjà en cours/);
    const woo = fakeWoo();
    // Deadline already passed: one batch, then the sync pauses (queued).
    await advanceSync(sync.id, Date.now() - 1, woo.transport);
    const paused = await getSync(actor, sync.id);
    expect(paused.status).toBe("queued");
    expect(paused.counts.created).toBe(50);
    await advanceSync(sync.id, Date.now() + 60_000, woo.transport);
    const done = await getSync(actor, sync.id);
    expect(done.status).toBe("done");
    expect(done.counts).toEqual({
      created: 120,
      updated: 0,
      skipped: 2,
      failed: 0,
    });
    expect(new Set(woo.created).size).toBe(120);
    expect(done.errors.map((error) => error.sku).sort()).toEqual([
      "P001",
      "PUSD",
    ]);
    await expect(resumeSync(actor, sync.id)).rejects.toThrow(/échec/);
  });
});
