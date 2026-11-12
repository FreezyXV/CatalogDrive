import { and, asc, eq, sql } from "drizzle-orm";
import type { ZodType } from "zod";
import { db } from "../db";
import { exportRequests, importJobs, processedRows } from "../db/schema";
import { processJob } from "../catalog";
import { createExport } from "../exports";
import { HttpError } from "../http";
import type { Delivery, Outcome } from "./broker";
import { DELIVERY_LIMIT } from "./topology";
import {
  exportGenerateCommand,
  importProcessCommand,
  type RejectedLinesEvent,
} from "./messages";
import { enqueue } from "./outbox";

export const REJECTED_BATCH_SIZE = 500;

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
    await processJob(job);
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
      await tx
        .update(importJobs)
        .set({ status: "failed", error: message })
        .where(
          and(eq(importJobs.id, job.id), eq(importJobs.runId, job.runId!)),
        );
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
  const batches = await publishOutcome(job.id, delivery.correlationId);
  log("import.processing.completed", {
    importId: job.id,
    rejectedBatches: batches,
  });
  return "ack";
}

/**
 * Publishes the completion event and the rejected lines (status `invalid`,
 * not excluded) in batches, through the outbox, in one transaction.
 */
export async function publishOutcome(importId: string, correlationId?: string) {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, importId));
    const invalid = and(
      eq(processedRows.importId, importId),
      eq(processedRows.organizationId, job.organizationId),
      eq(processedRows.status, "invalid"),
      eq(processedRows.excluded, 0),
    );
    const [{ total }] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(processedRows)
      .where(invalid);
    const batchCount = Math.ceil(total / REJECTED_BATCH_SIZE);
    let lastLine = 0;
    for (let batch = 1; batch <= batchCount; batch++) {
      const rows = await tx
        .select({
          sourceLine: processedRows.sourceLine,
          raw: processedRows.raw,
          issues: processedRows.issues,
        })
        .from(processedRows)
        .where(and(invalid, sql`${processedRows.sourceLine} > ${lastLine}`))
        .orderBy(asc(processedRows.sourceLine))
        .limit(REJECTED_BATCH_SIZE);
      lastLine = rows.at(-1)?.sourceLine ?? lastLine;
      const lines: RejectedLinesEvent["lines"] = rows.map((row) => ({
        sourceLine: row.sourceLine,
        raw: row.raw,
        issues: row.issues
          .filter((issue) => issue.severity === "error")
          .map(({ field, code, severity, message }) => ({
            field,
            code,
            severity,
            message,
          })),
      }));
      await enqueue(
        tx,
        {
          type: "import.lines.rejected",
          organizationId: job.organizationId,
          importId,
          batch,
          batchCount,
          lines,
        },
        correlationId || undefined,
      );
    }
    await enqueue(
      tx,
      {
        type: "import.processing.completed",
        organizationId: job.organizationId,
        importId,
        counts: (job.counts as Record<string, number> | null) ?? null,
        error: null,
      },
      correlationId || undefined,
    );
    return batchCount;
  });
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
    );
    await finishExport(request.id, delivery.correlationId, {
      status: "ready",
      exportId: exported.id,
      rowCount: exported.rowCount,
      rejectedCount: exported.rejectedCount,
      error: null,
    });
    log("export.completed", { requestId: request.id, exportId: exported.id });
    return "ack";
  } catch (error) {
    const permanent = isPermanent(error);
    if (!permanent && !lastAttempt(delivery)) {
      await db
        .update(exportRequests)
        .set({ status: "queued", updatedAt: new Date() })
        .where(eq(exportRequests.id, request.id));
      return "retry";
    }
    await finishExport(request.id, delivery.correlationId, {
      status: "failed",
      exportId: null,
      rowCount: null,
      rejectedCount: null,
      error: permanent
        ? (error as Error).message
        : "L’export a échoué après plusieurs tentatives.",
    });
    log("export.failed", { requestId: request.id, permanent });
    return permanent ? "ack" : "reject";
  }
}

export async function finishExport(
  requestId: string,
  correlationId: string | undefined,
  result: {
    status: "ready" | "failed";
    exportId: string | null;
    rowCount: number | null;
    rejectedCount: number | null;
    error: string | null;
  },
) {
  await db.transaction(async (tx) => {
    const [request] = await tx
      .update(exportRequests)
      .set({ ...result, updatedAt: new Date() })
      .where(eq(exportRequests.id, requestId))
      .returning();
    await enqueue(
      tx,
      {
        type: result.status === "ready" ? "export.completed" : "export.failed",
        organizationId: request.organizationId,
        requestId,
        importId: request.importId,
        exportId: result.exportId,
        error: result.error,
      },
      correlationId || undefined,
    );
  });
}
