/**
 * Integration worker (JOB_DISPATCH=queue).
 *
 * One process, three responsibilities:
 * 1. Outbox relay: PostgreSQL outbox → RabbitMQ, with publisher confirms.
 * 2. Command consumers: q.import.text, q.import.spreadsheet,
 *    q.export.cms, q.export.file.
 * 3. Notification consumer: q.notifications (structured log, stands in for
 *    an email or webhook sender).
 *
 * Usage: npm run worker:queue   (RABBITMQ_URL, DATABASE_URL)
 * Scale by running several instances: the relay uses SKIP LOCKED and each
 * queue dispatches fairly (prefetch 1) between consumers.
 */
import { config } from "dotenv";
config({
  path: process.env.APP_ENV === "test" ? ".env.test" : ".env.local",
  quiet: true,
});
const { AmqpBroker } = await import("../src/server/integration/broker");
const { relayOutbox } = await import("../src/server/integration/outbox");
const { handleImportProcess, handleExportGenerate } =
  await import("../src/server/integration/handlers");
const { QUEUES } = await import("../src/server/integration/topology");
const { sqlClient } = await import("../src/server/db");

const url = process.env.RABBITMQ_URL ?? "amqp://guest:guest@127.0.0.1:5672";
const only = process.env.WORKER_QUEUES?.split(",").map((q) => q.trim());
let stopping = false;
const stop = () => {
  stopping = true;
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

const consumers = [
  [QUEUES.importText, handleImportProcess],
  [QUEUES.importSpreadsheet, handleImportProcess],
  [QUEUES.exportCms, handleExportGenerate],
  [QUEUES.exportFile, handleExportGenerate],
] as const;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

while (!stopping) {
  let broker: Awaited<ReturnType<typeof AmqpBroker.connect>> | undefined;
  try {
    broker = await AmqpBroker.connect(url);
    for (const [queue, handler] of consumers)
      if (!only || only.includes(queue))
        await broker.consume(queue, handler, 1);
    if (!only || only.includes(QUEUES.notifications))
      await broker.consume(QUEUES.notifications, async (delivery) => {
        console.log(
          JSON.stringify({
            event: "notification",
            type: delivery.type,
            correlationId: delivery.correlationId,
          }),
        );
        return "ack";
      });
    console.log(
      JSON.stringify({ event: "worker.ready", queues: only ?? "all" }),
    );
    while (!stopping && broker.healthy) {
      try {
        if (!(await relayOutbox(broker))) await sleep(500);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "outbox.relay.error",
            error: error instanceof Error ? error.name : "UnknownError",
          }),
        );
        await sleep(3000);
      }
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "worker.broker.error",
        error: error instanceof Error ? error.name : "UnknownError",
      }),
    );
  } finally {
    await broker?.close();
  }
  if (!stopping) await sleep(3000);
}
await sqlClient.end();
