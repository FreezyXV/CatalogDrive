/**
 * Example downstream consumer of the rejected-lines channel.
 *
 * Reads `import.lines.rejected` batches from q.rejected-lines and writes,
 * per import, a CSV "supplier feedback" file listing each rejected line and
 * its reasons — the kind of file a purchasing team sends back to a supplier.
 * It shows that a new consumer can be added without touching the producer.
 *
 * Usage: npm run consumer:rejected   (writes to .local/rejected-lines/)
 */
import { mkdirSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const { AmqpBroker } = await import("../src/server/integration/broker");
const { QUEUES } = await import("../src/server/integration/topology");
const { rejectedLinesEvent } =
  await import("../src/server/integration/messages");

const url = process.env.RABBITMQ_URL ?? "amqp://guest:guest@127.0.0.1:5672";
const out = process.env.REJECTED_DIR ?? ".local/rejected-lines";
mkdirSync(out, { recursive: true });
const escape = (value: string) => `"${value.replaceAll('"', '""')}"`;

const broker = await AmqpBroker.connect(url);
await broker.consume(QUEUES.rejectedLines, async (delivery) => {
  const parsed = rejectedLinesEvent.safeParse(
    JSON.parse(delivery.body.toString("utf8")),
  );
  if (!parsed.success) return "reject";
  const event = parsed.data;
  const file = join(out, `${event.importId}.csv`);
  if (!existsSync(file)) appendFileSync(file, "line;field;code;message\n");
  for (const line of event.lines)
    for (const issue of line.issues)
      appendFileSync(
        file,
        [line.sourceLine, issue.field, issue.code, escape(issue.message)].join(
          ";",
        ) + "\n",
      );
  console.log(
    JSON.stringify({
      event: "rejected-lines.batch",
      importId: event.importId,
      batch: `${event.batch}/${event.batchCount}`,
      lines: event.lines.length,
      file,
    }),
  );
  return "ack";
});
console.log(
  JSON.stringify({ event: "consumer.ready", queue: QUEUES.rejectedLines }),
);
