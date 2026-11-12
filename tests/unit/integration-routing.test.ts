import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  routeMessage,
  sourceFamily,
} from "../../src/server/integration/router";
import {
  DELIVERY_LIMIT,
  EXCHANGES,
  QUEUES,
  queueArguments,
  queues,
  resolveQueues,
  topicMatches,
} from "../../src/server/integration/topology";
import { InMemoryBroker } from "../../src/server/integration/broker";
import {
  SCHEMA_VERSION,
  integrationMessage,
} from "../../src/server/integration/messages";

const org = randomUUID();
const importCommand = (sourceFormat: "csv" | "xlsx" | "xls" | "ods") =>
  integrationMessage.parse({
    schemaVersion: SCHEMA_VERSION,
    type: "import.process",
    organizationId: org,
    importId: randomUUID(),
    requestedBy: randomUUID(),
    sourceFormat,
    rowCount: 10,
  });
const exportCommand = (profile: string) =>
  integrationMessage.parse({
    schemaVersion: SCHEMA_VERSION,
    type: "export.generate",
    organizationId: org,
    requestId: randomUUID(),
    importId: randomUUID(),
    requestedBy: randomUUID(),
    profile,
  });

describe("routeur de contenu", () => {
  it("route les imports selon la famille du format source", () => {
    expect(sourceFamily("csv")).toBe("text");
    for (const format of ["xlsx", "xls", "ods"] as const)
      expect(sourceFamily(format)).toBe("spreadsheet");
    expect(routeMessage(importCommand("csv"))).toEqual({
      exchange: EXCHANGES.commands,
      routingKey: "import.process.text",
    });
    const route = routeMessage(importCommand("ods"));
    expect(resolveQueues(route.exchange, route.routingKey)).toEqual([
      QUEUES.importSpreadsheet,
    ]);
  });

  it("route les exports CMS et fichiers vers des files distinctes", () => {
    for (const profile of ["woocommerce", "prestashop", "shopify"]) {
      const route = routeMessage(exportCommand(profile));
      expect(route.routingKey).toBe(`export.generate.${profile}`);
      expect(resolveQueues(route.exchange, route.routingKey)).toEqual([
        QUEUES.exportCms,
      ]);
    }
    for (const profile of ["generic", "custom"]) {
      const route = routeMessage(exportCommand(profile));
      expect(resolveQueues(route.exchange, route.routingKey)).toEqual([
        QUEUES.exportFile,
      ]);
    }
  });

  it("diffuse les événements vers les abonnés concernés", () => {
    expect(resolveQueues(EXCHANGES.events, "import.lines.rejected")).toEqual([
      QUEUES.rejectedLines,
    ]);
    expect(
      resolveQueues(EXCHANGES.events, "import.processing.completed"),
    ).toEqual([QUEUES.notifications]);
    expect(resolveQueues(EXCHANGES.events, "export.failed")).toEqual([
      QUEUES.notifications,
    ]);
  });

  it("ne perd jamais un message sans destinataire : échange alternatif", () => {
    expect(resolveQueues(EXCHANGES.commands, "import.process.unknown")).toEqual(
      [QUEUES.unroutable],
    );
    expect(
      resolveQueues(EXCHANGES.commands, "export.generate.magento"),
    ).toEqual([QUEUES.unroutable]);
  });

  it("applique la sémantique AMQP des motifs topic", () => {
    expect(
      topicMatches("import.processing.*", "import.processing.failed"),
    ).toBe(true);
    expect(topicMatches("import.processing.*", "import.processing")).toBe(
      false,
    );
    expect(topicMatches("#", "a.b.c")).toBe(true);
    expect(topicMatches("export.#", "export")).toBe(true);
    expect(topicMatches("a.*.c", "a.b.b.c")).toBe(false);
  });

  it("déclare des files quorum avec limite de livraison et DLX", () => {
    const work = queues.find((q) => q.name === QUEUES.importText)!;
    expect(queueArguments(work)).toEqual({
      "x-queue-type": "quorum",
      "x-delivery-limit": DELIVERY_LIMIT,
      "x-dead-letter-exchange": EXCHANGES.deadLetter,
    });
    const dlq = queues.find((q) => q.name === QUEUES.deadLetter)!;
    expect(queueArguments(dlq)).toEqual({});
  });

  it("refuse un message hors contrat avant publication", () => {
    expect(() =>
      integrationMessage.parse({
        schemaVersion: SCHEMA_VERSION,
        type: "import.process",
        organizationId: org,
        importId: "pas-un-uuid",
      }),
    ).toThrow();
  });
});

describe("courtier en mémoire (même sémantique que RabbitMQ)", () => {
  const publish = (broker: InMemoryBroker) =>
    broker.publish({
      exchange: EXCHANGES.commands,
      routingKey: "import.process.text",
      body: { hello: "world" },
      messageId: randomUUID(),
      correlationId: "c-1",
      type: "import.process",
    });

  it("envoie en DLQ après la limite de livraisons", async () => {
    const broker = new InMemoryBroker();
    let calls = 0;
    await broker.consume(QUEUES.importText, async () => {
      calls++;
      return "retry";
    });
    await publish(broker);
    await broker.drain();
    expect(calls).toBe(DELIVERY_LIMIT + 1);
    const [dead] = broker.queues.get(QUEUES.deadLetter)!;
    expect(dead.headers["x-first-death-reason"]).toBe("delivery_limit");
  });

  it("envoie immédiatement en DLQ un message rejeté", async () => {
    const broker = new InMemoryBroker();
    let calls = 0;
    await broker.consume(QUEUES.importText, async () => {
      calls++;
      return "reject";
    });
    await publish(broker);
    await broker.drain();
    expect(calls).toBe(1);
    expect(broker.queues.get(QUEUES.deadLetter)![0].headers).toMatchObject({
      "x-first-death-reason": "rejected",
      "x-first-death-queue": QUEUES.importText,
    });
  });
});
