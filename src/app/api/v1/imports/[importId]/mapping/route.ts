import { z } from "zod";
import { readJson } from "@/server/http";
import { getImport } from "@/server/imports";
import { saveMapping } from "@/server/catalog";
import {
  importResource,
  json,
  problem,
  requireApiPrincipal,
} from "@/server/api/v1";
import {
  DEFAULT_RULES,
  mappingSchema,
  readOptionsSchema,
  ruleConfigSchema,
} from "@/domain/catalog";

const body = z.object({
  mapping: mappingSchema,
  rules: ruleConfigSchema.optional(),
  readOptions: readOptionsSchema.optional(),
  templateName: z.string().trim().min(1).max(80).optional(),
});

/** PUT /api/v1/imports/{importId}/mapping — idempotent. */
export async function PUT(
  request: Request,
  context: { params: Promise<{ importId: string }> },
) {
  try {
    const principal = await requireApiPrincipal(
      request,
      "catalog:write",
      "mapping:edit",
    );
    const { importId } = await context.params;
    const input = body.parse(await readJson(request, 128 * 1024));
    await saveMapping(
      principal,
      importId,
      input.mapping,
      input.rules ?? DEFAULT_RULES,
      input.readOptions ?? {},
      input.templateName,
    );
    return json(
      importResource(await getImport(principal, importId)),
      principal,
    );
  } catch (error) {
    return problem(error, request);
  }
}
