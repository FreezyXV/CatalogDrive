import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, type Transaction } from "../db";
import { outboxMessages } from "../db/schema";
import {
  SCHEMA_VERSION,
  integrationMessage,
  type IntegrationMessage,
} from "./messages";
import { routeMessage } from "./router";
import type { MessageBroker } from "./broker";

type WithoutEnvelope<T> = T extends unknown ? Omit<T, "schemaVersion"> : never;
export type NewMessage = WithoutEnvelope<IntegrationMessage>;

/**
 * Writes a message in the caller's transaction. Nothing reaches RabbitMQ
 * unless the business change commits; nothing is lost if it does
 * (the relay retries until the broker confirms).
 */
export async function enqueue(
  tx: Transaction,
  message: NewMessage,
  correlationId: string = randomUUID(),
) {
  const parsed = integrationMessage.parse({
    ...message,
    schemaVersion: SCHEMA_VERSION,
  });
  const route = routeMessage(parsed);
  const [row] = await tx
    .insert(outboxMessages)
    .values({
      organizationId: parsed.organizationId,
      type: parsed.type,
      payload: parsed as unknown as Record<string, unknown>,
      correlationId,
      route: `${route.exchange}/${route.routingKey}`,
    })
    .returning({ id: outboxMessages.id });
  return { messageId: row.id, route: route.routingKey };
}

const MAX_BACKOFF_SECONDS = 300;

/**
 * Relays pending outbox rows to the broker. Rows are claimed with
 * FOR UPDATE SKIP LOCKED so several relays can run concurrently without
 * publishing the same row twice in parallel. Delivery is at-least-once:
 * a crash between confirm and commit republishes the row, which is why
 * every consumer is idempotent (it checks the state it is about to change).
 */
export async function relayOutbox(broker: MessageBroker, limit = 50) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.status, "pending"),
          sql`${outboxMessages.availableAt} <= now()`,
        ),
      )
      .orderBy(outboxMessages.createdAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    const published: string[] = [];
    for (const row of rows) {
      const message = integrationMessage.parse(row.payload);
      const route = routeMessage(message);
      try {
        await broker.publish({
          ...route,
          body: message,
          messageId: row.id,
          correlationId: row.correlationId,
          type: row.type,
          headers: {
            "x-organization-id": row.organizationId,
            "x-schema-version": SCHEMA_VERSION,
          },
        });
        published.push(row.id);
      } catch (error) {
        const attempts = row.attempts + 1;
        await tx
          .update(outboxMessages)
          .set({
            attempts,
            lastError:
              error instanceof Error ? error.message : "publish failed",
            // Exponential backoff, capped: 2s, 4s, 8s ... 5 min.
            availableAt: sql`now() + make_interval(secs => ${Math.min(
              2 ** attempts,
              MAX_BACKOFF_SECONDS,
            )})`,
          })
          .where(eq(outboxMessages.id, row.id));
        // Keep order per relay pass: stop at the first broker failure.
        break;
      }
    }
    if (published.length)
      await tx
        .update(outboxMessages)
        .set({ status: "published", publishedAt: new Date(), lastError: null })
        .where(inArray(outboxMessages.id, published));
    return published.length;
  });
}

export async function pendingOutboxCount(organizationId?: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(outboxMessages)
    .where(
      and(
        eq(outboxMessages.status, "pending"),
        organizationId
          ? eq(outboxMessages.organizationId, organizationId)
          : undefined,
      ),
    );
  return row.count;
}
