import { getExportRequest } from "@/server/integration/export-requests";
import {
  exportRequestResource,
  json,
  problem,
  requireApiPrincipal,
} from "@/server/api/v1";

/** GET /api/v1/export-requests/{requestId} */
export async function GET(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  try {
    const principal = await requireApiPrincipal(
      request,
      "catalog:read",
      "import:read",
    );
    const { requestId } = await context.params;
    return json(
      exportRequestResource(await getExportRequest(principal, requestId)),
      principal,
    );
  } catch (error) {
    return problem(error, request);
  }
}
