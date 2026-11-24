import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  auditEvents,
  importJobs,
  processedRows,
  storeConnections,
  storeSyncs,
  usageRecords,
  type SyncCounts,
  type SyncError,
} from "../db/schema";
import { HttpError } from "../http";
import { getImport } from "../imports";
import type { Actor } from "../catalog";
import { cmsErrors, defaultExportConfig } from "@/domain/exports";
import {
  priceBasisMismatch,
  storeRowErrors,
  toStoreProduct,
  type ItemResult,
  type StoreProduct,
  type SyncOptions,
} from "@/domain/store-sync";
import { getConnection, openStore } from "./connections";
import { StoreError, type Transport } from "./network";
import { PUSH_BATCH } from "./types";

type Sync = typeof storeSyncs.$inferSelect;
const MAX_ERRORS = 200;
/** A runner that has not written for this long is presumed dead. */
const STALE_SECONDS = 90;

export function publicSync(sync: Sync) {
  return {
    id: sync.id,
    importId: sync.importId,
    connectionId: sync.connectionId,
    updateMode: sync.updateMode as SyncOptions["updateMode"],
    dryRun: sync.dryRun,
    status: sync.status as "queued" | "running" | "done" | "failed",
    total: sync.total,
    counts: sync.counts,
    errors: sync.errors,
    error: sync.error,
    createdAt: sync.createdAt,
    finishedAt: sync.finishedAt,
  };
}
export type PublicSync = ReturnType<typeof publicSync>;

export async function startSync(
  actor: Actor,
  importId: string,
  options: SyncOptions,
) {
  const { job } = await getImport(actor, importId);
  if (job.status !== "ready")
    throw new HttpError(409, "Attendez la fin du traitement avant d’envoyer.");
  const connection = await getConnection(actor, options.connectionId);
  return db.transaction(async (tx) => {
    // Serializes concurrent starts for the same import.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`store-sync:${importId}`}))`,
    );
    const [active] = await tx
      .select({ id: storeSyncs.id })
      .from(storeSyncs)
      .where(
        and(
          eq(storeSyncs.importId, importId),
          eq(storeSyncs.connectionId, connection.id),
          sql`${storeSyncs.status} IN ('queued', 'running')`,
        ),
      );
    if (active)
      throw new HttpError(
        409,
        "Un envoi vers cette boutique est déjà en cours pour cet import.",
      );
    const [{ total }] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(processedRows)
      .where(eligibleRows(actor.organizationId, importId));
    const [sync] = await tx
      .insert(storeSyncs)
      .values({
        organizationId: actor.organizationId,
        importId,
        connectionId: connection.id,
        requestedBy: actor.userId,
        updateMode: options.updateMode,
        dryRun: options.dryRun,
        total,
      })
      .returning();
    await tx.insert(auditEvents).values({
      ...actor,
      action: options.dryRun ? "store.sync.simulated" : "store.sync.started",
      entityId: sync.id,
    });
    if (!options.dryRun)
      await tx.insert(usageRecords).values({
        organizationId: actor.organizationId,
        kind: "store_sync",
        amount: 1,
        idempotencyKey: `store_sync:${sync.id}`,
      });
    return publicSync(sync);
  });
}

const eligibleRows = (organizationId: string, importId: string) =>
  and(
    eq(processedRows.organizationId, organizationId),
    eq(processedRows.importId, importId),
    eq(processedRows.status, "valid"),
    eq(processedRows.excluded, 0),
  );

export async function getSync(actor: Actor, id: string) {
  const [sync] = await db
    .select()
    .from(storeSyncs)
    .where(
      and(
        eq(storeSyncs.id, id),
        eq(storeSyncs.organizationId, actor.organizationId),
      ),
    );
  if (!sync) throw new HttpError(404, "Envoi introuvable.");
  return publicSync(sync);
}

export async function listSyncs(actor: Actor, importId: string) {
  await getImport(actor, importId);
  const rows = await db
    .select()
    .from(storeSyncs)
    .where(
      and(
        eq(storeSyncs.importId, importId),
        eq(storeSyncs.organizationId, actor.organizationId),
      ),
    )
    .orderBy(desc(storeSyncs.createdAt))
    .limit(20);
  return rows.map(publicSync);
}

/** A failed sync keeps its cursor: resuming continues where it stopped. */
export async function resumeSync(actor: Actor, id: string) {
  const [sync] = await db
    .update(storeSyncs)
    .set({ status: "queued", error: null, runId: null, finishedAt: null })
    .where(
      and(
        eq(storeSyncs.id, id),
        eq(storeSyncs.organizationId, actor.organizationId),
        eq(storeSyncs.status, "failed"),
      ),
    )
    .returning();
  if (!sync) throw new HttpError(409, "Seul un envoi en échec peut reprendre.");
  return publicSync(sync);
}

/** Same filters as file exports, plus store currency and duplicate SKUs. */
function rowRejections(
  row: typeof processedRows.$inferSelect,
  context: {
    platform: "shopify" | "woocommerce";
    priceBasis: "excl_tax" | "incl_tax";
    defaultCurrency: string;
    store: { name: string; currency: string; pricesIncludeTax: boolean };
    firstLineBySku: Map<string, number>;
  },
) {
  const reasons = [
    ...cmsErrors(
      row.data,
      {
        ...defaultExportConfig(context.platform),
        priceBasis: context.priceBasis,
      },
      context.priceBasis,
    ),
    ...storeRowErrors(row.data, context.store, context.defaultCurrency),
  ];
  const first = context.firstLineBySku.get((row.data.sku ?? "").toUpperCase());
  if (first !== undefined && first !== row.sourceLine)
    reasons.push(
      `SKU déjà envoyé depuis la ligne ${first} : une boutique exige un SKU unique.`,
    );
  return reasons;
}

/**
 * Advances a sync until it is done, fails, or the deadline passes.
 * One runner at a time (run_id). Each batch commits its cursor, so a crash
 * replays at most one batch, and the SKU lookup turns the replay into
 * updates rather than duplicates.
 */
export async function advanceSync(
  id: string,
  deadline: number,
  transport?: Transport,
) {
  const claimed = await db.execute<{ run_id: string }>(sql`
    UPDATE store_syncs
    SET status = 'running', run_id = gen_random_uuid(), heartbeat_at = now()
    WHERE id = ${id}
      AND (status = 'queued'
        OR (status = 'running' AND heartbeat_at < now() - make_interval(secs => ${STALE_SECONDS})))
    RETURNING run_id`);
  const runId = claimed[0]?.run_id;
  if (!runId) return;
  const owned = and(eq(storeSyncs.id, id), eq(storeSyncs.runId, runId));
  const [sync] = await db
    .select()
    .from(storeSyncs)
    .where(eq(storeSyncs.id, id));
  const fail = (message: string) =>
    db
      .update(storeSyncs)
      .set({
        status: "failed",
        error: message,
        runId: null,
        finishedAt: new Date(),
      })
      .where(owned);
  try {
    const [connection] = await db
      .select()
      .from(storeConnections)
      .where(
        and(
          eq(storeConnections.id, sync.connectionId),
          eq(storeConnections.organizationId, sync.organizationId),
        ),
      );
    const [job] = await db
      .select({ rules: importJobs.rules })
      .from(importJobs)
      .where(eq(importJobs.id, sync.importId));
    if (!connection || !job?.rules)
      return void (await fail("Boutique ou import introuvable."));
    const client = await openStore(connection, transport);
    const store = await client.probe();
    const mismatch = priceBasisMismatch(job.rules.priceBasis, store);
    if (mismatch) return void (await fail(mismatch));
    const duplicates = await db
      .select({
        sku: sql<string>`upper(${processedRows.data}->>'sku')`,
        first: sql<number>`min(${processedRows.sourceLine})::int`,
      })
      .from(processedRows)
      .where(eligibleRows(sync.organizationId, sync.importId))
      .groupBy(sql`1`)
      .having(sql`count(*) > 1`);
    const context = {
      platform: connection.platform as "shopify" | "woocommerce",
      priceBasis: job.rules.priceBasis,
      defaultCurrency: job.rules.defaultCurrency,
      store,
      firstLineBySku: new Map(duplicates.map((d) => [d.sku, d.first])),
    };
    let cursor = sync.cursor;
    while (true) {
      const batch = await db
        .select()
        .from(processedRows)
        .where(
          and(
            eligibleRows(sync.organizationId, sync.importId),
            sql`${processedRows.sourceLine} > ${cursor}`,
          ),
        )
        .orderBy(asc(processedRows.sourceLine))
        .limit(PUSH_BATCH);
      if (!batch.length) {
        await db
          .update(storeSyncs)
          .set({ status: "done", runId: null, finishedAt: new Date() })
          .where(owned);
        return;
      }
      const results: ItemResult[] = [];
      const products: StoreProduct[] = [];
      for (const row of batch) {
        const reasons = rowRejections(row, context);
        if (reasons.length)
          results.push({
            line: row.sourceLine,
            sku: row.data.sku ?? "",
            outcome: "skipped",
            message: reasons.join(" "),
          });
        else products.push(toStoreProduct(row.data, row.sourceLine));
      }
      results.push(
        ...(await client.push(products, {
          updateMode: sync.updateMode as SyncOptions["updateMode"],
          dryRun: sync.dryRun,
        })),
      );
      cursor = batch.at(-1)!.sourceLine;
      const [saved] = await db
        .update(storeSyncs)
        .set({
          cursor,
          heartbeatAt: new Date(),
          counts: addCounts(results),
          errors: appendErrors(results),
          ...(Date.now() > deadline ? { status: "queued", runId: null } : {}),
        })
        .where(owned)
        .returning({ status: storeSyncs.status });
      // Lost ownership (connection deleted, or a takeover): stop silently.
      if (!saved || saved.status === "queued") return;
    }
  } catch (error) {
    if (error instanceof StoreError || error instanceof HttpError) {
      await fail(error.message);
      return;
    }
    await fail("Envoi interrompu par une erreur inattendue. Reprenez l’envoi.");
    throw error;
  }
}

function addCounts(results: ItemResult[]) {
  const delta: SyncCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  for (const result of results) delta[result.outcome]++;
  return sql`jsonb_build_object(
    'created', (${storeSyncs.counts}->>'created')::int + ${delta.created}::int,
    'updated', (${storeSyncs.counts}->>'updated')::int + ${delta.updated}::int,
    'skipped', (${storeSyncs.counts}->>'skipped')::int + ${delta.skipped}::int,
    'failed', (${storeSyncs.counts}->>'failed')::int + ${delta.failed}::int)`;
}

function appendErrors(results: ItemResult[]) {
  const errors: SyncError[] = results
    .filter((result) => result.message)
    .slice(0, MAX_ERRORS)
    .map(({ line, sku, message }) => ({ line, sku, message: message! }));
  return sql`CASE WHEN jsonb_array_length(${storeSyncs.errors}) >= ${MAX_ERRORS}::int
    THEN ${storeSyncs.errors}
    ELSE (SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM (
      SELECT e FROM jsonb_array_elements(${storeSyncs.errors} || ${JSON.stringify(errors)}::jsonb) WITH ORDINALITY AS t(e, n)
      ORDER BY n LIMIT ${MAX_ERRORS}::int) s)
    END`;
}

/** Worker entry point: resumes a queued or abandoned sync, if any. */
export async function runNextSync(budgetMs = 10 * 60_000) {
  const [next] = await db
    .select({ id: storeSyncs.id })
    .from(storeSyncs)
    .where(
      sql`${storeSyncs.status} = 'queued' OR (${storeSyncs.status} = 'running' AND ${storeSyncs.heartbeatAt} < now() - make_interval(secs => ${STALE_SECONDS}))`,
    )
    .orderBy(asc(storeSyncs.createdAt))
    .limit(1);
  if (!next) return false;
  await advanceSync(next.id, Date.now() + budgetMs);
  return true;
}
