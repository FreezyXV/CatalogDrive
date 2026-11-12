import { readJson } from "@/server/http";
import {
  exportRequestInput,
  requestExport,
} from "@/server/integration/export-requests";
import {
  exportRequestResource,
  json,
  problem,
  requireApiPrincipal,
} from "@/server/api/v1";

export const maxDuration = 300;

/** POST /api/v1/imports/{importId}/exports — 202, routed by target profile. */
export async function POST(
  request: Request,
  context: { params: Promise<{ importId: string }> },
) {
  try {
    const principal = await requireApiPrincipal(
      request,
      "catalog:export",
      "export:create",
    );
    const { importId } = await context.params;
    const input = exportRequestInput.parse(await readJson(request, 16 * 1024));
    const created = await requestExport(
      principal,
      importId,
      input,
      principal.correlationId,
    );
    return json(exportRequestResource(created), principal, {
      status: 202,
      headers: { Location: `/api/v1/export-requests/${created.id}` },
    });
  } catch (error) {
    return problem(error, request);
  }
}
