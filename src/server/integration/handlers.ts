import { and, eq, sql } from "drizzle-orm";
import type { ZodType } from "zod";
import { db } from "../db";
import { exportRequests, importJobs } from "../db/schema";
import { processJob } from "../catalog";
import { createExport } from "../exports";
import { HttpError } from "../http";
import type { Delivery, Outcome } from "./broker";
import { DELIVERY_LIMIT } from "./topology";
import { exportGenerateCommand, importProcessCommand } from "./messages";
import { enqueue } from "./outbox";
import { activeExportAttempt } from "./export-state";

function log(event: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...data }));
}

/** Invalid Message Channel: anything unparsable is rejected, never retried. */
function parse<T>(delivery: Delivery, schema: ZodType<T>): T | null {
  try {
    const result = schema.safeParse(JSON.parse(delivery.body.toString("utf8")));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Business failures are final; infrastructure failures deserve a retry. */
function isPermanent(error: unknown) {
  return (
    error instanceof HttpError ||
    (error instanceof Error && error.name === "ImportError")
  );
}

const lastAttempt = (delivery: Delivery) =>
  delivery.deliveryCount >= DELIVERY_LIMIT;

/**
 * Consumer of q.import.text and q.import.spreadsheet.
 *
 * Idempotent: the job is claimed with a conditional UPDATE. A duplicate
 * message (at-least-once delivery) finds nothing to claim and is acked.
 * A redelivered message may take over a job left in `processing` by a
 * consumer that died; the previous owner, if still alive, loses ownership
 * because every batch write checks the run id.
 */
export async function handleImportProcess(
  delivery: Delivery,
): Promise<Outcome> {
  const command = parse(delivery, importProcessCommand);
  if (!command) {
    log("message.rejected", {
      messageId: delivery.messageId,
      reason: "schema",
    });
    return "reject";
  }
  const claimed = await db.execute(sql`
    UPDATE import_jobs
    SET status = 'processing', run_id = gen_random_uuid(),
        heartbeat_at = now(), attempts = attempts + 1
    WHERE id = ${command.importId}
      AND organization_id = ${command.organizationId}
      AND attempts < ${DELIVERY_LIMIT + 1}
      AND (status = 'queued' OR (status = 'processing' AND ${delivery.redelivered}))
    RETURNING id`);
  if (!claimed[0]) {
    log("message.duplicate", {
      messageId: delivery.messageId,
      importId: command.importId,
    });
    return "ack";
  }
  const [job] = await db
    .select()
    .from(importJobs)
    .where(eq(importJobs.id, command.importId));
  log("import.processing.started", {
    importId: job.id,
    correlationId: delivery.correlationId,
    queue: delivery.routingKey,
    delivery: delivery.deliveryCount + 1,
  });
  try {
    await processJob(job, {
      correlationId: delivery.correlationId || undefined,
    });
  } catch (error) {
    const permanent = isPermanent(error);
    if (!permanent && !lastAttempt(delivery)) {
      await db
        .update(importJobs)
        .set({ status: "queued" })
        .where(
          and(eq(importJobs.id, job.id), eq(importJobs.runId, job.runId!)),
        );
      log("import.processing.retry", {
        importId: job.id,
        error: error instanceof Error ? error.name : "Unknown",
      });
      return "retry";
    }
    const message = permanent
      ? (error as Error).message
      : `Le traitement a échoué après ${delivery.deliveryCount + 1} tentatives. Relancez le traitement.`;
    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(importJobs)
        .set({ status: "failed", error: message })
        .where(and(eq(importJobs.id, job.id), eq(importJobs.runId, job.runId!)))
        .returning({ id: importJobs.id });
      if (!updated) return;
      await enqueue(
        tx,
        {
          type: "import.processing.failed",
          organizationId: job.organizationId,
          importId: job.id,
          counts: null,
          error: message,
        },
        delivery.correlationId || undefined,
      );
    });
    log("import.processing.failed", { importId: job.id, permanent });
    // A business failure is a handled outcome; an exhausted retry is a poison
    // message and goes to the dead letter queue for investigation.
    return permanent ? "ack" : "reject";
  }
  log("import.processing.completed", { importId: job.id });
  return "ack";
}

/** Consumer of q.export.cms and q.export.file. */
export async function handleExportGenerate(
  delivery: Delivery,
): Promise<Outcome> {
  const command = parse(delivery, exportGenerateCommand);
  if (!command) {
    log("message.rejected", {
      messageId: delivery.messageId,
      reason: "schema",
    });
    return "reject";
  }
  const [request] = await db
    .update(exportRequests)
    .set({
      status: "processing",
      attempts: sql`${exportRequests.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(exportRequests.id, command.requestId),
        eq(exportRequests.organizationId, command.organizationId),
        delivery.redelivered
          ? sql`${exportRequests.status} IN ('queued', 'processing')`
          : eq(exportRequests.status, "queued"),
      ),
    )
    .returning();
  if (!request) {
    log("message.duplicate", {
      messageId: delivery.messageId,
      requestId: command.requestId,
    });
    return "ack";
  }
  const actor = {
    userId: request.requestedBy,
    organizationId: request.organizationId,
  };
  try {
    const exported = await createExport(
      actor,
      request.importId,
      request.config,
      undefined,
      {
        attempt: request,
        notify: { correlationId: delivery.correlationId || undefined },
      },
    );
    log("export.completed", { requestId: request.id, exportId: exported.id });
    return "ack";
  } catch (error) {
    const permanent = isPermanent(error);
    if (!permanent && !lastAttempt(delivery)) {
      await db
        .update(exportRequests)
        .set({ status: "queued", updatedAt: new Date() })
        .where(activeExportAttempt(request));
      return "retry";
    }
    const message = permanent
      ? (error as Error).message
      : "L’export a échoué après plusieurs tentatives.";
    await db.transaction(async (tx) => {
      const [failed] = await tx
        .update(exportRequests)
        .set({ status: "failed", error: message, updatedAt: new Date() })
        .where(activeExportAttempt(request))
        .returning({ id: exportRequests.id });
      if (failed)
        await enqueue(
          tx,
          {
            type: "export.failed",
            organizationId: request.organizationId,
            requestId: request.id,
            importId: request.importId,
            exportId: null,
            error: message,
          },
          delivery.correlationId || undefined,
        );
    });
    log("export.failed", { requestId: request.id, permanent });
    return permanent ? "ack" : "reject";
  }
}
