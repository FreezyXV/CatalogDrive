import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { db, lockTransaction, type Transaction } from "../db";
import {
  importJobs,
  organizations,
  sourceArchives,
  uploadedFiles,
  usageRecords,
} from "../db/schema";
import { HttpError } from "../http";
import {
  PLANS,
  effectivePlanId,
  formatBytes,
  formatQuota,
  type Plan,
} from "@/domain/plans";
import type { ExportConfig } from "@/domain/exports";
import { billingEnabled } from "./config";

type Executor = typeof db | Transaction;

/**
 * Plan quotas apply once online payment is possible (Stripe key and prices set),
 * or when QUOTAS_ENFORCED=true forces them (accompanied sale, tests).
 * QUOTAS_ENFORCED=false keeps the unlimited pilot even with Stripe set.
 */
export function quotasEnforced() {
  const flag = process.env.QUOTAS_ENFORCED;
  if (flag === "true") return true;
  if (flag === "false") return false;
  return billingEnabled();
}

export class QuotaError extends HttpError {
  constructor(message: string) {
    super(
      402,
      `${message} Passez à une offre supérieure depuis Paramètres > Abonnement.`,
    );
  }
}

export async function organizationPlan(
  organizationId: string,
  executor: Executor = db,
): Promise<Plan> {
  const [organization] = await executor
    .select({
      plan: organizations.plan,
      status: organizations.subscriptionStatus,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return PLANS[effectivePlanId(organization?.plan, organization?.status)];
}

/** Start of the current calendar month in UTC: quotas reset on the 1st. */
export function periodStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function monthlyUsage(
  organizationId: string,
  executor: Executor = db,
  options: { excludeImportId?: string } = {},
) {
  const since = periodStart();
  const [recorded] = await executor
    .select({
      rows: sql<string>`coalesce(sum(case when ${usageRecords.kind}='processed_rows' then ${usageRecords.amount} else 0 end),0)::bigint`,
      exports: sql<string>`coalesce(sum(case when ${usageRecords.kind}='export' then ${usageRecords.amount} else 0 end),0)::bigint`,
    })
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.organizationId, organizationId),
        gte(usageRecords.createdAt, since),
      ),
    );
  // Queued or running imports reserve their rows so that parallel launches
  // cannot overshoot the monthly allowance before usage is recorded.
  const [reserved] = await executor
    .select({
      rows: sql<string>`coalesce(sum((${importJobs.diagnostic}->>'rowCount')::bigint),0)::bigint`,
    })
    .from(importJobs)
    .where(
      and(
        eq(importJobs.organizationId, organizationId),
        inArray(importJobs.status, ["queued", "processing"]),
        options.excludeImportId
          ? ne(importJobs.id, options.excludeImportId)
          : undefined,
      ),
    );
  return {
    rows: Number(recorded.rows) + Number(reserved.rows),
    exports: Number(recorded.exports),
  };
}

export async function storedBytes(
  organizationId: string,
  executor: Executor = db,
) {
  const [files] = await executor
    .select({
      bytes: sql<string>`coalesce(sum(${uploadedFiles.sizeBytes}),0)::bigint`,
    })
    .from(uploadedFiles)
    .where(eq(uploadedFiles.organizationId, organizationId));
  const [archives] = await executor
    .select({
      bytes: sql<string>`coalesce(sum(${sourceArchives.sizeBytes}),0)::bigint`,
    })
    .from(sourceArchives)
    .where(eq(sourceArchives.organizationId, organizationId));
  return Number(files.bytes) + Number(archives.bytes);
}

/** Called inside the transaction that queues an import. */
export async function assertProcessingQuota(
  tx: Transaction,
  organizationId: string,
  importId: string,
  rowCount: number,
) {
  if (!quotasEnforced()) return;
  // Serializes concurrent launches of the same organization.
  await lockTransaction(tx, `quota:${organizationId}`);
  const plan = await organizationPlan(organizationId, tx);
  if (rowCount > plan.quotas.rowsPerImport)
    throw new QuotaError(
      `Ce fichier contient ${formatQuota(rowCount)} lignes ; l’offre ${plan.name} en traite ${formatQuota(plan.quotas.rowsPerImport)} par import.`,
    );
  const usage = await monthlyUsage(organizationId, tx, {
    excludeImportId: importId,
  });
  if (usage.rows + rowCount > plan.quotas.monthlyRows)
    throw new QuotaError(
      `Quota mensuel atteint : ${formatQuota(usage.rows)} lignes déjà traitées sur ${formatQuota(plan.quotas.monthlyRows)} pour l’offre ${plan.name}.`,
    );
}

export async function assertExportQuota(
  organizationId: string,
  config: Pick<ExportConfig, "profile">,
  options: { templateName?: string; executor?: Executor } = {},
) {
  if (!quotasEnforced()) return;
  const executor = options.executor ?? db;
  const plan = await organizationPlan(organizationId, executor);
  if (
    !plan.quotas.cmsProfiles &&
    ["woocommerce", "prestashop", "shopify"].includes(config.profile)
  )
    throw new QuotaError(
      `Les profils WooCommerce, PrestaShop et Shopify ne sont pas inclus dans l’offre ${plan.name}.`,
    );
  if (options.templateName) assertTemplatesAllowed(plan);
  if (plan.quotas.monthlyExports === null) return;
  const usage = await monthlyUsage(organizationId, executor);
  if (usage.exports >= plan.quotas.monthlyExports)
    throw new QuotaError(
      `Quota mensuel atteint : ${formatQuota(plan.quotas.monthlyExports)} exports pour l’offre ${plan.name}.`,
    );
}

function assertTemplatesAllowed(plan: Plan) {
  if (!plan.quotas.templates)
    throw new QuotaError(
      `Les modèles enregistrés ne sont pas inclus dans l’offre ${plan.name}.`,
    );
}

export async function assertTemplateQuota(organizationId: string) {
  if (!quotasEnforced()) return;
  assertTemplatesAllowed(await organizationPlan(organizationId));
}

/** Checked before a file is accepted, with its declared size. */
export async function assertStorageQuota(
  organizationId: string,
  incomingBytes: number,
) {
  if (!quotasEnforced()) return;
  const plan = await organizationPlan(organizationId);
  const used = await storedBytes(organizationId);
  if (used + Math.max(0, incomingBytes) > plan.quotas.storageBytes)
    throw new QuotaError(
      `Espace de stockage insuffisant : ${formatBytes(used)} utilisés sur ${formatBytes(plan.quotas.storageBytes)} pour l’offre ${plan.name}. Supprimez d’anciens imports ou réduisez la durée de conservation.`,
    );
}

export async function assertRetentionAllowed(
  organizationId: string,
  retentionDays: number,
) {
  if (!quotasEnforced()) return;
  const plan = await organizationPlan(organizationId);
  if (retentionDays > plan.quotas.maxRetentionDays)
    throw new QuotaError(
      `L’offre ${plan.name} conserve les fichiers ${plan.quotas.maxRetentionDays} jours au maximum.`,
    );
}

/** Usage and limits shown on the settings page. */
export async function billingOverview(organizationId: string) {
  const [organization] = await db
    .select({
      plan: organizations.plan,
      status: organizations.subscriptionStatus,
      currentPeriodEnd: organizations.currentPeriodEnd,
      cancelAtPeriodEnd: organizations.cancelAtPeriodEnd,
      hasCustomer: sql<boolean>`${organizations.stripeCustomerId} is not null`,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  const plan = PLANS[effectivePlanId(organization?.plan, organization?.status)];
  const [usage, storage] = await Promise.all([
    monthlyUsage(organizationId),
    storedBytes(organizationId),
  ]);
  return {
    plan,
    subscribedPlan: organization?.plan ?? "essai",
    status: organization?.status ?? null,
    currentPeriodEnd: organization?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: organization?.cancelAtPeriodEnd ?? false,
    hasCustomer: Boolean(organization?.hasCustomer),
    usage: { ...usage, storageBytes: storage },
    enforced: quotasEnforced(),
  };
}
