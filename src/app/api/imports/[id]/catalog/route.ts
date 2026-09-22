import { z } from "zod";
import { requireIdentity } from "@/server/auth";
import { checkOrigin, errorResponse, readJson, HttpError } from "@/server/http";
import { getImport } from "@/server/imports";
import {
  saveMapping,
  queueImport,
  reviewRow,
  qualityRows,
  runJob,
} from "@/server/catalog";
import { inspectSource } from "@/server/source";
import { getFileStore } from "@/server/storage";
import { createExport } from "@/server/exports";
import {
  mappingSchema,
  ruleConfigSchema,
  readOptionsSchema,
  suggestMapping,
} from "@/domain/catalog";
import { exportConfigSchema } from "@/domain/exports";
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("inspect"), options: readOptionsSchema }),
  z.object({
    action: z.literal("mapping"),
    mapping: mappingSchema,
    rules: ruleConfigSchema,
    options: readOptionsSchema,
    templateName: z.string().trim().min(1).max(80).optional(),
  }),
  z.object({ action: z.literal("process") }),
  z.object({
    action: z.literal("review"),
    rowId: z.uuid(),
    version: z.number().int().positive(),
    decision: z.enum(["accept", "edit", "keep", "exclude", "restore", "reset"]),
    issueId: z.string().max(150).optional(),
    value: z.string().max(65536).optional(),
  }),
  z.object({
    action: z.literal("export"),
    config: exportConfigSchema,
    templateName: z.string().trim().min(1).max(80).optional(),
  }),
]);
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    checkOrigin(request);
    const actor = await requireIdentity();
    const { id } = await context.params;
    const body = command.parse(await readJson(request, 128 * 1024));
    const imported = await getImport(actor, id);
    if (body.action === "inspect") {
      if (["processing", "queued"].includes(imported.job.status))
        throw new HttpError(409, "Traitement en cours.");
      const diagnostic = await inspectSource(
        getFileStore(),
        imported.file.storageKey,
        imported.file.originalName,
        body.options,
      );
      return Response.json({
        diagnostic,
        mapping: suggestMapping(diagnostic.headers),
      });
    }
    if (body.action === "mapping")
      return Response.json({
        diagnostic: await saveMapping(
          actor,
          id,
          body.mapping,
          body.rules,
          body.options,
          body.templateName,
        ),
      });
    if (body.action === "process") {
      await queueImport(actor, id);
      await runJob(id);
      return Response.json({ ok: true });
    }
    if (body.action === "review")
      return Response.json({
        counts: await reviewRow(actor, id, body.rowId, {
          version: body.version,
          action: body.decision,
          issueId: body.issueId,
          value: body.value,
        }),
      });
    return Response.json(
      { export: await createExport(actor, id, body.config, body.templateName) },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export const maxDuration = 300;
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await requireIdentity();
    const { id } = await context.params;
    const query = new URL(request.url).searchParams;
    const page = z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .parse(query.get("page") ?? 1);
    const result = await qualityRows(
      actor,
      id,
      query.get("status") ?? undefined,
      page,
    );
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
