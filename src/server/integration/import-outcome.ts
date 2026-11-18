import { and, asc, eq, sql } from "drizzle-orm";
import type { QualityCounts } from "@/domain/catalog";
import type { Transaction } from "../db";
import { type importJobs, processedRows } from "../db/schema";
import type { RejectedLinesEvent } from "./messages";
import { enqueue } from "./outbox";

const REJECTED_BATCH_SIZE = 500;

export async function enqueueImportOutcome(
  tx: Transaction,
  job: typeof importJobs.$inferSelect,
  counts: QualityCounts,
  correlationId?: string,
) {
  const importId = job.id;
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
      correlationId,
    );
  }
  await enqueue(
    tx,
    {
      type: "import.processing.completed",
      organizationId: job.organizationId,
      importId,
      counts: counts,
      error: null,
    },
    correlationId,
  );
}
