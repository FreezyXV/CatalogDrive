import { eq, sql } from "drizzle-orm";
import { db } from "./db";
import {
  auditEvents,
  organizations,
  uploadedFiles,
  usageRecords,
} from "./db/schema";
import type { Identity } from "./auth";

export async function organizationSummary(actor: Identity) {
  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, actor.organizationId));
  const [usage] = await db
    .select({
      rows: sql<number>`coalesce(sum(case when ${usageRecords.kind}='processed_rows' then ${usageRecords.amount} else 0 end),0)::int`,
      exports: sql<number>`coalesce(sum(case when ${usageRecords.kind}='export' then ${usageRecords.amount} else 0 end),0)::int`,
    })
    .from(usageRecords)
    .where(eq(usageRecords.organizationId, actor.organizationId));
  const [storage] = await db
    .select({
      bytes: sql<number>`coalesce(sum(${uploadedFiles.sizeBytes}),0)::int`,
    })
    .from(uploadedFiles)
    .where(eq(uploadedFiles.organizationId, actor.organizationId));
  return { organization, usage, storageBytes: storage.bytes };
}

export async function updateOrganization(
  actor: Identity,
  values: { name: string; retentionDays: number },
) {
  return db.transaction(async (tx) => {
    const [organization] = await tx
      .update(organizations)
      .set(values)
      .where(eq(organizations.id, actor.organizationId))
      .returning();
    await tx.insert(auditEvents).values({
      ...actor,
      action: "organization.updated",
      entityId: actor.organizationId,
    });
    return organization;
  });
}
