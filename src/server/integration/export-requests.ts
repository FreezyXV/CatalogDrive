import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { auditEvents, exportRequests, importJobs } from "../db/schema";
import { createExport } from "../exports";
import { getImport } from "../imports";
import { lockImport, type Actor } from "../catalog";
import { HttpError } from "../http";
import {
  defaultExportConfig,
  exportConfigSchema,
  validateExportConfig,
  type ExportConfig,
} from "@/domain/exports";
import { dispatchMode } from "./dispatch";
import { enqueue } from "./outbox";

/** Public input: only the profile is required, the rest defaults per profile. */
export const exportRequestInput = z.object({
  profile: z.enum([
    "generic",
    "woocommerce",
    "prestashop",
    "shopify",
    "custom",
  ]),
  columns: exportConfigSchema.shape.columns.optional(),
  delimiter: z.enum([",", ";", "\t"]).optional(),
  encoding: z.enum(["utf-8", "utf-8-bom", "windows-1252"]).optional(),
  priceBasis: z.enum(["excl_tax", "incl_tax"]).optional(),
});
export type ExportRequestInput = z.infer<typeof exportRequestInput>;

export function buildExportConfig(input: ExportRequestInput): ExportConfig {
  if (input.profile === "custom" && !input.columns?.length)
    throw new HttpError(422, "Le profil personnalisé exige des colonnes.");
  const defaults = defaultExportConfig(input.profile);
  const config = exportConfigSchema.parse({
    ...defaults,
    ...Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ),
  });
  try {
    validateExportConfig(config);
  } catch (error) {
    throw new HttpError(422, (error as Error).message);
  }
  return config;
}

/**
 * Records an export request. In queue mode the command `export.generate`
 * is written to the outbox in the same transaction and routed by profile;
 * in inline mode the export is produced immediately.
 */
export async function requestExport(
  actor: Actor,
  importId: string,
  input: ExportRequestInput,
  correlationId?: string,
) {
  await getImport(actor, importId);
  const config = buildExportConfig(input);
  const request = await db.transaction(async (tx) => {
    await lockImport(tx, importId);
    const [job] = await tx
      .select({ status: importJobs.status })
      .from(importJobs)
      .where(
        and(
          eq(importJobs.id, importId),
          eq(importJobs.organizationId, actor.organizationId),
        ),
      );
    if (job.status !== "ready")
      throw new HttpError(
        409,
        "Attendez la fin du traitement avant d’exporter.",
      );
    const [created] = await tx
      .insert(exportRequests)
      .values({
        organizationId: actor.organizationId,
        importId,
        requestedBy: actor.userId,
        profile: config.profile,
        config,
      })
      .returning();
    await tx.insert(auditEvents).values({
      ...actor,
      action: "export.requested",
      entityId: created.id,
    });
    if (dispatchMode() === "queue") {
      const { route } = await enqueue(
        tx,
        {
          type: "export.generate",
          organizationId: actor.organizationId,
          requestId: created.id,
          importId,
          requestedBy: actor.userId,
          profile: config.profile,
        },
        correlationId,
      );
      const [routed] = await tx
        .update(exportRequests)
        .set({ route })
        .where(eq(exportRequests.id, created.id))
        .returning();
      return routed;
    }
    return created;
  });
  if (dispatchMode() === "queue") return request;
  try {
    const exported = await createExport(actor, importId, config);
    const [ready] = await db
      .update(exportRequests)
      .set({
        status: "ready",
        exportId: exported.id,
        rowCount: exported.rowCount,
        rejectedCount: exported.rejectedCount,
        updatedAt: new Date(),
      })
      .where(eq(exportRequests.id, request.id))
      .returning();
    return ready;
  } catch (error) {
    await db
      .update(exportRequests)
      .set({
        status: "failed",
        error:
          error instanceof HttpError ? error.message : "Export impossible.",
        updatedAt: new Date(),
      })
      .where(eq(exportRequests.id, request.id));
    throw error;
  }
}

export async function getExportRequest(actor: Actor, id: string) {
  if (!z.uuid().safeParse(id).success)
    throw new HttpError(404, "Demande d’export introuvable.");
  const [request] = await db
    .select()
    .from(exportRequests)
    .where(
      and(
        eq(exportRequests.id, id),
        eq(exportRequests.organizationId, actor.organizationId),
      ),
    );
  if (!request) throw new HttpError(404, "Demande d’export introuvable.");
  return request;
}
