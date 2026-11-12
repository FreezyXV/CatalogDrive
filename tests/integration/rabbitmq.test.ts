/**
 * Runs against a real RabbitMQ broker (vhost dedicated to tests).
 * Skipped when RABBITMQ_URL is not set, e.g. in a CI without a broker.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Channel, ChannelModel, GetMessage } from "amqplib";
import { db, sqlClient } from "../../src/server/db";
import {
  auditEvents,
  importJobs,
  memberships,
  organizations,
  outboxMessages,
  usageRecords,
  users,
} from "../../src/server/db/schema";
import { registerAccount } from "../../src/server/auth";
import { getImport, importCsv } from "../../src/server/imports";
import { LocalFileStore } from "../../src/server/storage";
import { queueImport, saveMapping } from "../../src/server/catalog";
import { DEFAULT_RULES } from "../../src/domain/catalog";
import { AmqpBroker, newMessageId } from "../../src/server/integration/broker";
import { relayOutbox } from "../../src/server/integration/outbox";
import { handleImportProcess } from "../../src/server/integration/handlers";
import {
  DELIVERY_LIMIT,
  EXCHANGES,
  QUEUES,
} from "../../src/server/integration/topology";

const url = process.env.RABBITMQ_URL;
const suite = url ? describe : describe.skip;
let broker: AmqpBroker;
let connection: ChannelModel;
let channel: Channel;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(probe: () => Promise<T | false>, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await probe();
    if (value) return value;
    await sleep(100);
  }
  throw new Error("Délai dépassé");
}
const get = (queue: string) =>
  waitFor<GetMessage>(async () => channel.get(queue, { noAck: true }));
const raw = (routingKey: string, exchange: string = EXCHANGES.commands) => ({
  exchange,
  routingKey,
  body: { probe: randomUUID() },
  messageId: newMessageId(),
  correlationId: `test-${randomUUID()}`,
  type: "probe",
});

beforeAll(async () => {
  if (!url) return;
  const amqp = await import("amqplib");
  broker = await AmqpBroker.connect(url);
  // Asserting twice must be harmless (every process asserts on start).
  await broker.assertTopology();
  connection = await amqp.connect(url);
  channel = await connection.createChannel();
  for (const queue of Object.values(QUEUES)) await channel.purgeQueue(queue);
});
afterAll(async () => {
  await channel?.close().catch(() => undefined);
  await connection?.close().catch(() => undefined);
  await broker?.close();
});

suite("RabbitMQ réel", () => {
  it("route par contenu vers la bonne file, confirmé par le broker", async () => {
    await broker.publish(raw("import.process.spreadsheet"));
    await broker.publish(raw("export.generate.prestashop"));
    await broker.publish(raw("export.generate.custom"));
    expect((await get(QUEUES.importSpreadsheet)).fields.routingKey).toBe(
      "import.process.spreadsheet",
    );
    expect((await get(QUEUES.exportCms)).fields.routingKey).toBe(
      "export.generate.prestashop",
    );
    expect((await get(QUEUES.exportFile)).fields.routingKey).toBe(
      "export.generate.custom",
    );
    expect(await channel.get(QUEUES.importText)).toBe(false);
  });

  it("capture un message sans route dans l’échange alternatif", async () => {
    await broker.publish(raw("export.generate.magento"));
    const message = await get(QUEUES.unroutable);
    expect(message.fields.routingKey).toBe("export.generate.magento");
  });

  it("dead-lettering réel : message rejeté puis limite de livraisons", async () => {
    let deliveries = 0;
    await broker.consume(QUEUES.exportFile, async (delivery) => {
      deliveries++;
      return delivery.type === "reject-me" ? "reject" : "retry";
    });
    await broker.publish({
      ...raw("export.generate.generic"),
      type: "reject-me",
    });
    const rejected = await get(QUEUES.deadLetter);
    const rejectedDeath = (
      rejected.properties.headers?.["x-death"] as {
        reason: string;
        queue: string;
      }[]
    )[0];
    expect(rejectedDeath).toMatchObject({
      reason: "rejected",
      queue: QUEUES.exportFile,
    });

    deliveries = 0;
    await broker.publish(raw("export.generate.generic"));
    const poisoned = await get(QUEUES.deadLetter);
    const death = (
      poisoned.properties.headers?.["x-death"] as {
        reason: string;
      }[]
    )[0];
    expect(death.reason).toBe("delivery_limit");
    expect(deliveries).toBe(DELIVERY_LIMIT + 1);
  });
});

suite("pipeline complet sur RabbitMQ réel et PostgreSQL", () => {
  let actor: { userId: string; organizationId: string };
  let root: string;
  let pipeline: AmqpBroker;
  const previous = process.env.JOB_DISPATCH;

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "drizzle" });
    root = await mkdtemp(join(tmpdir(), "catamotive-rabbit-"));
    process.env.STORAGE_DRIVER = "local";
    process.env.LOCAL_STORAGE_DIR = root;
    process.env.JOB_DISPATCH = "queue";
    await db
      .update(outboxMessages)
      .set({ status: "published" })
      .where(eq(outboxMessages.status, "pending"));
    actor = await registerAccount(
      `rabbit-${randomUUID()}@example.test`,
      "mot-de-passe-test-uniquement",
      "Organisation RabbitMQ",
    );
    pipeline = await AmqpBroker.connect(url!);
    await pipeline.consume(QUEUES.importText, handleImportProcess);
  });
  afterAll(async () => {
    process.env.JOB_DISPATCH = previous;
    await pipeline?.close();
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

  it("outbox → RabbitMQ → worker → import prêt + lignes rejetées publiées", async () => {
    const store = new LocalFileStore(root);
    const id = await importCsv(
      actor,
      "reel.csv",
      new Blob([
        "SKU;Nom;Prix\nR-1;Disque;10,00\nR-2;Étrier;abc\nR-3;Mâchoire;-1\n",
      ]).stream(),
      store,
    );
    await saveMapping(
      actor,
      id,
      { sku: 0, product_name: 1, sale_price: 2 },
      DEFAULT_RULES,
      {},
    );
    await queueImport(actor, id, { correlationId: "corr-reel" });
    expect(await relayOutbox(pipeline)).toBe(1);
    await waitFor(async () =>
      (await getImport(actor, id)).job.status === "ready" ? true : false,
    );
    // The worker wrote the follow-up events to the outbox; relay them.
    await waitFor(async () => (await relayOutbox(pipeline)) > 0);
    const rejected = await get(QUEUES.rejectedLines);
    const body = JSON.parse(rejected.content.toString());
    expect(body).toMatchObject({ type: "import.lines.rejected", importId: id });
    expect(body.lines.length).toBeGreaterThanOrEqual(1);
    expect(rejected.properties.correlationId).toBe("corr-reel");
    expect(rejected.properties.headers?.["x-organization-id"]).toBe(
      actor.organizationId,
    );
    const notification = await get(QUEUES.notifications);
    expect(notification.properties.type).toBe("import.processing.completed");
  });
});
