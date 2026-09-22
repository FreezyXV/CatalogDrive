import { and, eq, inArray, sql, desc, asc } from "drizzle-orm";
import { db } from "./db";
import {
  importJobs,
  processedRows,
  mappingTemplates,
  auditEvents,
  usageRecords,
} from "./db/schema";
import { getImport } from "./imports";
import { inspectSource } from "./source";
import { getFileStore } from "./storage";
import { HttpError } from "./http";
import { type Identity } from "./auth";
import {
  DEFAULT_RULES,
  type Mapping,
  type ReadOptions,
  type RuleConfig,
  type Decision,
  type Issue,
  type Field,
  fieldKeys,
  validateMapping,
  emptyCounts,
  type QualityCounts,
} from "@/domain/catalog";
import { normalizeRow, similarity, statusFor } from "@/domain/normalization";

export type Actor = Pick<Identity, "userId" | "organizationId">;
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export const lockImport = async (tx: Transaction, id: string) => {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`,
  );
};
export async function saveMapping(
  actor: Actor,
  id: string,
  mapping: Mapping,
  rules: RuleConfig,
  options: ReadOptions,
  templateName?: string,
) {
  const { job, file } = await getImport(actor, id);
  if (["queued", "processing", "ready", "deleting"].includes(job.status))
    throw new HttpError(
      409,
      "Cet import a déjà été lancé. Créez un nouvel import pour appliquer un autre mapping.",
    );
  const diagnostic = await inspectSource(
    getFileStore(),
    file.storageKey,
    file.originalName,
    options,
  );
  try {
    validateMapping(mapping, diagnostic.headers.length);
  } catch (error) {
    throw new HttpError(422, (error as Error).message);
  }
  await db.transaction(async (tx) => {
    await lockImport(tx, id);
    const [updated] = await tx
      .update(importJobs)
      .set({
        mapping,
        rules,
        readOptions: options,
        diagnostic,
        status: "mapped",
        error: null,
      })
      .where(
        and(
          eq(importJobs.id, id),
          eq(importJobs.organizationId, actor.organizationId),
          inArray(importJobs.status, ["analyzed", "mapped", "failed"]),
        ),
      )
      .returning();
    if (!updated)
      throw new HttpError(409, "L’import a changé. Rechargez la page.");
    if (templateName)
      await tx
        .insert(mappingTemplates)
        .values({
          organizationId: actor.organizationId,
          name: templateName,
          headers: diagnostic.headers,
          mapping,
          rules,
          readOptions: options,
        })
        .onConflictDoUpdate({
          target: [mappingTemplates.organizationId, mappingTemplates.name],
          set: {
            headers: diagnostic.headers,
            mapping,
            rules,
            readOptions: options,
            version: sql`${mappingTemplates.version}+1`,
          },
        });
    await tx
      .insert(auditEvents)
      .values({ ...actor, action: "mapping.saved", entityId: id });
  });
  return diagnostic;
}
export async function queueImport(actor: Actor, id: string) {
  await getImport(actor, id);
  await db.transaction(async (tx) => {
    await lockImport(tx, id);
    const [job] = await tx
      .select()
      .from(importJobs)
      .where(
        and(
          eq(importJobs.id, id),
          eq(importJobs.organizationId, actor.organizationId),
        ),
      );
    if (["queued", "processing", "ready"].includes(job.status)) return;
    if (!job.mapping || !job.rules)
      throw new HttpError(422, "Validez le mapping avant le traitement.");
    await tx
      .update(importJobs)
      .set({ status: "queued", error: null, processedCount: 0, attempts: 0 })
      .where(eq(importJobs.id, id));
    await tx
      .insert(auditEvents)
      .values({ ...actor, action: "processing.queued", entityId: id });
  });
}
type StoredRow = typeof processedRows.$inferSelect;
function activeIssues(issues: Issue[], decisions: Decision[]) {
  return issues.filter(
    (issue) =>
      !decisions.some(
        (decision) =>
          decision.issueId === issue.id && decision.action === "keep",
      ),
  );
}
export async function duplicatePass(
  tx: Transaction,
  job: typeof importJobs.$inferSelect,
) {
  const exact = new Map<string, { line: number; data: StoredRow["data"] }>();
  const buckets = new Map<
    string,
    { line: number; data: StoredRow["data"] }[]
  >();
  let cursor = 0;
  const counts = emptyCounts();
  while (true) {
    const rows = await tx
      .select()
      .from(processedRows)
      .where(
        and(
          eq(processedRows.importId, job.id),
          eq(processedRows.organizationId, job.organizationId),
          sql`${processedRows.sourceLine} > ${cursor}`,
        ),
      )
      .orderBy(asc(processedRows.sourceLine))
      .limit(200);
    if (!rows.length) break;
    for (const row of rows) {
      cursor = row.sourceLine;
      let issues = row.issues.filter(
        (issue) => !issue.code.startsWith("duplicate_"),
      );
      const sku = (row.data.sku ?? "").toUpperCase().replace(/[\s.\-/]/g, "");
      const brand = (row.data.brand ?? "").toUpperCase();
      const key = `${brand}\u0000${sku}`;
      if (!row.excluded && sku) {
        const previous = exact.get(key);
        if (previous)
          issues.push({
            id: "_row:duplicate_exact",
            field: "_row",
            code: "duplicate_exact",
            severity: "warning",
            original: row.data.sku ?? "",
            message: `Même SKU et marque que la ligne ${previous.line}. Vérifiez avant de conserver ou d’exclure.`,
            score: 1,
            relatedLine: previous.line,
          });
        else {
          exact.set(key, { line: row.sourceLine, data: row.data });
          const bucketKey = `${brand}\u0000${sku.slice(0, 3)}`;
          const candidates = buckets.get(bucketKey) ?? [];
          if (job.rules?.fuzzyDuplicates) {
            const probable = candidates
              .map((candidate) => ({
                candidate,
                score: similarity(sku, candidate.data.sku ?? ""),
              }))
              .sort((a, b) => b.score - a.score)[0];
            if (probable && probable.score >= 0.82 && probable.score < 1)
              issues.push({
                id: "_row:duplicate_probable",
                field: "_row",
                code: "duplicate_probable",
                severity: "warning",
                original: row.data.sku ?? "",
                message: `Référence proche de la ligne ${probable.candidate.line} (similarité de bigrammes, recherche bornée). Aucune fusion automatique.`,
                score: Number(probable.score.toFixed(3)),
                relatedLine: probable.candidate.line,
              });
          }
          if (candidates.length < 30) {
            candidates.push({ line: row.sourceLine, data: row.data });
            buckets.set(bucketKey, candidates);
          }
        }
      }
      issues = activeIssues(issues, row.decisions);
      const status = statusFor(issues);
      if (
        JSON.stringify(issues) !== JSON.stringify(row.issues) ||
        status !== row.status
      )
        await tx
          .update(processedRows)
          .set({
            issues,
            status,
            confidence:
              status === "valid" ? "1" : status === "invalid" ? "0" : "0.6",
          })
          .where(eq(processedRows.id, row.id));
      counts.total++;
      if (row.excluded) counts.excluded++;
      else counts[status]++;
      if (issues.some((issue) => issue.code.startsWith("duplicate_")))
        counts.duplicates++;
      if (row.transformations.length) counts.transformed++;
    }
  }
  return counts;
}
export async function processJob(job: typeof importJobs.$inferSelect) {
  const actor = { userId: job.createdBy, organizationId: job.organizationId };
  const { file } = await getImport(actor, job.id);
  if (!job.mapping || !job.rules || !job.runId)
    throw new Error("Configuration de traitement absente");
  await db
    .delete(processedRows)
    .where(
      and(
        eq(processedRows.importId, job.id),
        eq(processedRows.organizationId, job.organizationId),
      ),
    );
  let batch: (typeof processedRows.$inferInsert)[] = [];
  let count = 0;
  const at = new Date().toISOString();
  const flush = async () => {
    if (!batch.length) return;
    await db.transaction(async (tx) => {
      const [owner] = await tx
        .update(importJobs)
        .set({ processedCount: count, heartbeatAt: new Date() })
        .where(
          and(
            eq(importJobs.id, job.id),
            eq(importJobs.runId, job.runId!),
            eq(importJobs.status, "processing"),
          ),
        )
        .returning({ id: importJobs.id });
      if (!owner) throw new Error("Le job n’est plus détenu par ce worker");
      await tx.insert(processedRows).values(batch);
    });
    batch = [];
  };
  await inspectSource(
    getFileStore(),
    file.storageKey,
    file.originalName,
    job.readOptions,
    async (record, headers) => {
      const normalized = normalizeRow(record.values, job.mapping!, job.rules!, {
        line: record.line,
        headers,
        at,
        origin: `${file.originalName}:${job.readOptions.sheet ?? "CSV"}:${record.line}`,
      });
      count++;
      batch.push({
        organizationId: job.organizationId,
        importId: job.id,
        runId: job.runId!,
        sourceLine: record.line,
        raw: record.values,
        ...normalized,
        confidence: String(normalized.confidence),
      });
      if (batch.length >= 100) await flush();
    },
  );
  await flush();
  await db.transaction(async (tx) => {
    await lockImport(tx, job.id);
    const [current] = await tx
      .select()
      .from(importJobs)
      .where(and(eq(importJobs.id, job.id), eq(importJobs.runId, job.runId!)));
    if (!current) throw new Error("Job remplacé");
    const counts = await duplicatePass(tx, job);
    await tx
      .update(importJobs)
      .set({ status: "ready", counts, heartbeatAt: new Date(), error: null })
      .where(eq(importJobs.id, job.id));
    await tx
      .insert(usageRecords)
      .values({
        organizationId: job.organizationId,
        kind: "processed_rows",
        amount: count,
        idempotencyKey: `process:${job.id}`,
      })
      .onConflictDoNothing();
    await tx
      .insert(auditEvents)
      .values({ ...actor, action: "processing.completed", entityId: job.id });
  });
}
export async function runNextJob() {
  // PostgreSQL performs the claim atomically; stale jobs are retried at most three times.
  const result = await db.execute(
    sql`UPDATE import_jobs SET status='processing', run_id=gen_random_uuid(), heartbeat_at=now(), attempts=attempts+1 WHERE id=(SELECT id FROM import_jobs WHERE (status='queued' OR (status='processing' AND heartbeat_at < now()-interval '10 minutes')) AND attempts<3 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id`,
  );
  const id = result[0]?.id as string | undefined;
  if (!id) {
    await db.execute(
      sql`UPDATE import_jobs SET status='failed',error='Traitement interrompu à trois reprises. Relancez le traitement.' WHERE status='processing' AND attempts>=3 AND heartbeat_at < now()-interval '10 minutes'`,
    );
    return false;
  }
  const [job] = await db.select().from(importJobs).where(eq(importJobs.id, id));
  try {
    await processJob(job);
  } catch (error) {
    const message =
      error instanceof Error && error.name === "ImportError"
        ? error.message
        : "Le traitement a échoué. Vérifiez le fichier et relancez.";
    await db
      .update(importJobs)
      .set({ status: "failed", error: message })
      .where(and(eq(importJobs.id, id), eq(importJobs.runId, job.runId!)));
    console.error(
      JSON.stringify({
        event: "processing.failed",
        jobId: id,
        error: error instanceof Error ? error.name : "Unknown",
      }),
    );
  }
  return true;
}
export async function runJob(id: string) {
  const result = await db.execute(
    sql`UPDATE import_jobs SET status='processing', run_id=gen_random_uuid(), heartbeat_at=now(), attempts=attempts+1 WHERE id=${id} AND status='queued' AND attempts<3 RETURNING id`,
  );
  if (!result[0]) return false;
  const [job] = await db.select().from(importJobs).where(eq(importJobs.id, id));
  try {
    await processJob(job);
  } catch (error) {
    const message =
      error instanceof Error && error.name === "ImportError"
        ? error.message
        : "Le traitement a échoué. Vérifiez le fichier et relancez.";
    await db
      .update(importJobs)
      .set({ status: "failed", error: message })
      .where(and(eq(importJobs.id, id), eq(importJobs.runId, job.runId!)));
    console.error(
      JSON.stringify({
        event: "processing.failed",
        jobId: id,
        error: error instanceof Error ? error.name : "Unknown",
      }),
    );
    throw error;
  }
  return true;
}
export async function reviewRow(
  actor: Actor,
  id: string,
  rowId: string,
  input: {
    version: number;
    action: "accept" | "edit" | "keep" | "exclude" | "restore" | "reset";
    issueId?: string;
    value?: string;
  },
) {
  await getImport(actor, id);
  return db.transaction(async (tx) => {
    await lockImport(tx, id);
    const [job] = await tx
      .select()
      .from(importJobs)
      .where(
        and(
          eq(importJobs.id, id),
          eq(importJobs.organizationId, actor.organizationId),
        ),
      );
    if (job.status !== "ready")
      throw new HttpError(409, "Le traitement n’est pas terminé.");
    const [row] = await tx
      .select()
      .from(processedRows)
      .where(
        and(
          eq(processedRows.id, rowId),
          eq(processedRows.importId, id),
          eq(processedRows.organizationId, actor.organizationId),
        ),
      );
    if (!row) throw new HttpError(404, "Ligne introuvable.");
    if (row.version !== input.version)
      throw new HttpError(
        409,
        "Cette ligne a été modifiée. Rechargez-la avant de continuer.",
      );
    const at = new Date().toISOString();
    const issue = row.issues.find((i) => i.id === input.issueId);
    let changes: Partial<typeof processedRows.$inferInsert> = {
      version: row.version + 1,
    };
    if (input.action === "exclude" || input.action === "restore")
      changes.excluded = input.action === "exclude" ? 1 : 0;
    else if (input.action === "reset") {
      const reset = normalizeRow(row.raw, job.mapping!, job.rules!, {
        line: row.sourceLine,
        headers: job.diagnostic.headers,
        at,
        origin: `import:${id}:${row.sourceLine}`,
      });
      changes = {
        ...changes,
        ...reset,
        confidence: String(reset.confidence),
        decisions: [],
        excluded: 0,
      };
    } else {
      if (!issue)
        throw new HttpError(404, "Anomalie introuvable ou déjà résolue.");
      if (input.action === "accept" && issue.suggestion === undefined)
        throw new HttpError(422, "Cette anomalie n’a pas de suggestion.");
      if (input.action === "edit" && issue.field === "_row")
        throw new HttpError(
          422,
          "Une anomalie de ligne doit être conservée ou exclue.",
        );
      const value =
        input.action === "accept"
          ? issue.suggestion!
          : input.action === "edit"
            ? (input.value ?? "")
            : issue.original;
      const decision: Decision = {
        issueId: issue.id,
        action: input.action,
        original: issue.original,
        result: value,
        value,
        at,
        actor: actor.userId,
      };
      const decisions = [...row.decisions, decision];
      if (input.action === "keep")
        changes = {
          ...changes,
          decisions,
          issues: activeIssues(row.issues, decisions),
        };
      else {
        const data = { ...row.data, [issue.field]: value };
        const directMapping = Object.fromEntries(
          fieldKeys.map((field, index) => [field, index]),
        ) as Mapping;
        const normalized = normalizeRow(
          fieldKeys.map((field) => data[field] ?? ""),
          directMapping,
          job.rules ?? DEFAULT_RULES,
          {
            line: row.sourceLine,
            headers: fieldKeys,
            at,
            origin: `manual:${actor.userId}`,
          },
        );
        const issues = activeIssues(
          [
            ...normalized.issues,
            ...row.issues.filter((i) => i.field === "_row"),
          ],
          decisions,
        );
        changes = {
          ...changes,
          data: normalized.data,
          issues,
          decisions,
          transformations: [
            ...row.transformations,
            {
              field: issue.field as Field,
              original: row.data[issue.field as Field] ?? "",
              value,
              rule: `manual_${input.action}`,
              version: "1.0.0",
              at,
              origin: actor.userId,
            },
            ...normalized.transformations,
          ],
        };
      }
    }
    await tx
      .update(processedRows)
      .set(changes)
      .where(eq(processedRows.id, row.id));
    const counts = await duplicatePass(tx, job);
    await tx.update(importJobs).set({ counts }).where(eq(importJobs.id, id));
    await tx
      .insert(auditEvents)
      .values({ ...actor, action: `row.${input.action}`, entityId: row.id });
    return counts;
  });
}
export async function qualityRows(
  actor: Actor,
  id: string,
  status?: string,
  page = 1,
) {
  const { job } = await getImport(actor, id);
  const conditions = [
    eq(processedRows.importId, id),
    eq(processedRows.organizationId, actor.organizationId),
  ];
  if (status === "excluded") conditions.push(eq(processedRows.excluded, 1));
  else if (status && ["valid", "ambiguous", "invalid"].includes(status))
    conditions.push(
      eq(processedRows.status, status),
      eq(processedRows.excluded, 0),
    );
  return {
    job,
    rows: await db
      .select()
      .from(processedRows)
      .where(and(...conditions))
      .orderBy(asc(processedRows.sourceLine))
      .limit(50)
      .offset((page - 1) * 50),
  };
}
export async function listMappingTemplates(actor: Actor) {
  return db
    .select()
    .from(mappingTemplates)
    .where(eq(mappingTemplates.organizationId, actor.organizationId))
    .orderBy(desc(mappingTemplates.createdAt));
}
export async function qualitySummary(
  actor: Actor,
  id: string,
): Promise<QualityCounts> {
  return (await getImport(actor, id)).job.counts ?? emptyCounts();
}
