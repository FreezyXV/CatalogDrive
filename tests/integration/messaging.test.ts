import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../../src/server/db";
import {
  auditEvents,
  exportRequests,
  importJobs,
  memberships,
  organizations,
  outboxMessages,
  usageRecords,
  users,
} from "../../src/server/db/schema";
import { registerAccount } from "../../src/server/auth";
import { importCsv, getImport } from "../../src/server/imports";
import { LocalFileStore } from "../../src/server/storage";
import { queueImport, saveMapping } from "../../src/server/catalog";
import { DEFAULT_RULES } from "../../src/domain/catalog";
import { InMemoryBroker } from "../../src/server/integration/broker";
import { relayOutbox } from "../../src/server/integration/outbox";
import {
  handleExportGenerate,
  handleImportProcess,
} from "../../src/server/integration/handlers";
import {
  getExportRequest,
  requestExport,
} from "../../src/server/integration/export-requests";
import { QUEUES } from "../../src/server/integration/topology";
import { rejectedLinesEvent } from "../../src/server/integration/messages";

if (!process.env.DATABASE_URL?.endsWith("/catamotive_test"))
  throw new Error("Base dédiée catamotive_test requise (.env.test).");

let actor: { userId: string; organizationId: string };
let store: LocalFileStore;
let root: string;
const previousDispatch = process.env.JOB_DISPATCH;

const CATALOG =
  "Référence;Désignation;Marque;Prix;Stock\n" +
  "A001;Filtre;Bosch;12,50;4\n" +
  "A002;Plaquette;Bosch;19,90;2\n" +
  "A003;Pièce invalide;Bosch;prix;1\n" +
  "A004;Sans prix valide;Valeo;-3;1\n";
const MAPPING = {
  sku: 0,
  product_name: 1,
  brand: 2,
  sale_price: 3,
  stock_quantity: 4,
} as const;

async function mappedImport(content = CATALOG, name = "flux.csv") {
  const id = await importCsv(actor, name, new Blob([content]).stream(), store);
  await saveMapping(actor, id, MAPPING, DEFAULT_RULES, {});
  return id;
}

function wire(broker: InMemoryBroker) {
  return Promise.all([
    broker.consume(QUEUES.importText, handleImportProcess),
    broker.consume(QUEUES.importSpreadsheet, handleImportProcess),
    broker.consume(QUEUES.exportCms, handleExportGenerate),
    broker.consume(QUEUES.exportFile, handleExportGenerate),
  ]);
}

async function pump(broker: InMemoryBroker) {
  // Relay outbox → broker → handlers until nothing moves (handlers enqueue
  // follow-up events in the outbox).
  for (let i = 0; i < 10; i++) {
    await broker.drain();
    const sent = await relayOutbox(broker, 500);
    if (!sent) return;
  }
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "drizzle" });
  root = await mkdtemp(join(tmpdir(), "catamotive-messaging-"));
  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_DIR = root;
  process.env.JOB_DISPATCH = "queue";
  store = new LocalFileStore(root);
  actor = await registerAccount(
    `queue-${randomUUID()}@example.test`,
    "mot-de-passe-test-uniquement",
    "Organisation file",
  );
});
// Each test owns its broker: discard commands left pending by a previous test
// so that they are not relayed into the next one.
beforeEach(async () => {
  await db
    .update(outboxMessages)
    .set({ status: "published" })
    .where(eq(outboxMessages.status, "pending"));
});

afterAll(async () => {
  process.env.JOB_DISPATCH = previousDispatch;
  if (actor) {
    await db
      .delete(importJobs)
      .where(eq(importJobs.organizationId, actor.organizationId));
    await db
      .delete(auditEvents)
      .where(eq(auditEvents.organizationId, actor.organizationId));
    await db
      .delete(usageRecords)
      .where(eq(usageRecords.organizationId, actor.organizationId));
    await db.delete(memberships).where(eq(memberships.userId, actor.userId));
    await db
      .delete(organizations)
      .where(eq(organizations.id, actor.organizationId));
    await db.delete(users).where(eq(users.id, actor.userId));
  }
  if (root) await rm(root, { recursive: true, force: true });
  await sqlClient.end();
});

describe("pipeline asynchrone : outbox → RabbitMQ (sémantique) → workers", () => {
  it("écrit la commande dans l’outbox dans la même transaction que l’état queued", async () => {
    const id = await mappedImport();
    const result = await queueImport(actor, id, { correlationId: "corr-1" });
    expect(result).toMatchObject({
      queued: true,
      route: "import.process.text",
    });
    const [row] = await db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, result.messageId!));
    expect(row).toMatchObject({
      status: "pending",
      type: "import.process",
      correlationId: "corr-1",
      route: "catamotive.commands/import.process.text",
    });
    expect((await getImport(actor, id)).job.status).toBe("queued");
    // Second call: idempotent, no new command.
    expect(await queueImport(actor, id)).toEqual({
      queued: false,
      messageId: null,
      route: null,
    });
  });

  it("traite l’import via la file, publie fin de traitement et lignes rejetées", async () => {
    const broker = new InMemoryBroker();
    await wire(broker);
    const id = await mappedImport();
    await queueImport(actor, id, { correlationId: "corr-2" });
    await pump(broker);

    const { job } = await getImport(actor, id);
    expect(job.status).toBe("ready");
    expect(job.counts).toMatchObject({ total: 4 });
    const invalid = job.counts!.invalid;
    expect(invalid).toBeGreaterThanOrEqual(1);

    const rejected = broker.queues.get(QUEUES.rejectedLines)!;
    expect(rejected).toHaveLength(1);
    const event = rejectedLinesEvent.parse(
      JSON.parse(rejected[0].body.toString()),
    );
    expect(event).toMatchObject({ importId: id, batch: 1, batchCount: 1 });
    expect(event.lines).toHaveLength(invalid);
    expect(event.lines.every((line) => line.issues.length > 0)).toBe(true);
    expect(rejected[0].correlationId).toBe("corr-2");

    const notifications = broker.queues.get(QUEUES.notifications)!;
    expect(notifications.map((m) => m.type)).toContain(
      "import.processing.completed",
    );
    expect(broker.queues.get(QUEUES.deadLetter)).toHaveLength(0);
  });

  it("consommateur idempotent : un doublon de message ne retraite pas", async () => {
    const broker = new InMemoryBroker();
    await wire(broker);
    const id = await mappedImport();
    await queueImport(actor, id);
    await relayOutbox(broker, 500);
    // Simulate at-least-once delivery: the same message arrives twice.
    const queue = broker.queues.get(QUEUES.importText)!;
    queue.push({ ...queue[0] });
    await broker.drain();
    const { job } = await getImport(actor, id);
    expect(job.status).toBe("ready");
    expect(job.attempts).toBe(1);
    expect(broker.queues.get(QUEUES.deadLetter)).toHaveLength(0);
  });

  it("route un message hors contrat directement en DLQ", async () => {
    const broker = new InMemoryBroker();
    await wire(broker);
    await broker.publish({
      exchange: "catamotive.commands",
      routingKey: "import.process.text",
      body: { type: "import.process", importId: "corrompu" },
      messageId: randomUUID(),
      correlationId: "corr-bad",
      type: "import.process",
    });
    await broker.drain();
    const [dead] = broker.queues.get(QUEUES.deadLetter)!;
    expect(dead.headers["x-first-death-reason"]).toBe("rejected");
  });

  it("panne d’infrastructure : réessais puis DLQ, import marqué en échec", async () => {
    const broker = new InMemoryBroker();
    await wire(broker);
    const id = await mappedImport();
    await queueImport(actor, id);
    // The stored source file disappears (storage outage / lost object):
    // not a business error, so the consumer retries before giving up.
    const { file } = await getImport(actor, id);
    await store.remove(file.storageKey);
    await relayOutbox(broker, 500);
    await broker.drain();
    const dead = broker.queues.get(QUEUES.deadLetter)!;
    expect(dead).toHaveLength(1);
    expect(dead[0].deliveries).toBe(4);
    const { job } = await getImport(actor, id);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("après 4 tentatives");
  });

  it("broker indisponible : l’outbox conserve et réessaie avec backoff", async () => {
    const broker = new InMemoryBroker();
    const id = await mappedImport();
    const { messageId } = await queueImport(actor, id);
    broker.failNextPublish = true;
    expect(await relayOutbox(broker, 500)).toBe(0);
    const [row] = await db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, messageId!));
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("indisponible");
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());
    // Make it due again and relay: published once the broker is back.
    await db
      .update(outboxMessages)
      .set({ availableAt: new Date(Date.now() - 1000) })
      .where(eq(outboxMessages.id, messageId!));
    expect(await relayOutbox(broker, 500)).toBe(1);
    const [after] = await db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, messageId!));
    expect(after.status).toBe("published");
  });

  it("export asynchrone routé vers la file CMS puis prêt", async () => {
    const broker = new InMemoryBroker();
    await wire(broker);
    const id = await mappedImport();
    await queueImport(actor, id);
    await pump(broker);
    const request = await requestExport(
      actor,
      id,
      { profile: "shopify" },
      "corr-export",
    );
    expect(request).toMatchObject({
      status: "queued",
      route: "export.generate.shopify",
    });
    await relayOutbox(broker, 500);
    expect(broker.queues.get(QUEUES.exportCms)).toHaveLength(1);
    await pump(broker);
    const done = await getExportRequest(actor, request.id);
    expect(done.error).toBeNull();
    expect(done.status).toBe("ready");
    expect(done.exportId).toBeTruthy();
    expect(
      broker.queues.get(QUEUES.notifications)!.map((m) => m.type),
    ).toContain("export.completed");
  });

  it("aucune ligne exportable : échec 422 immédiat, sans blocage du flux", async () => {
    const broker = new InMemoryBroker();
    await wire(broker);
    const id = await mappedImport(
      "Référence;Désignation;Marque;Prix;Stock\nZ1;Sans prix;Bosch;abc;1\n",
    );
    await queueImport(actor, id);
    await pump(broker);
    const request = await requestExport(actor, id, { profile: "woocommerce" });
    const started = Date.now();
    await pump(broker);
    const done = await getExportRequest(actor, request.id);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("Aucune ligne n’est exportable");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("export impossible (import non prêt) : refus immédiat 409", async () => {
    const id = await mappedImport();
    await expect(
      requestExport(actor, id, { profile: "generic" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await db
        .select()
        .from(exportRequests)
        .where(
          and(
            eq(exportRequests.importId, id),
            eq(exportRequests.organizationId, actor.organizationId),
          ),
        ),
    ).toHaveLength(0);
  });
});
