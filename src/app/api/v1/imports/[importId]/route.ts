import { getImport } from "@/server/imports";
import {
  importResource,
  json,
  problem,
  requireApiPrincipal,
} from "@/server/api/v1";

/** GET /api/v1/imports/{importId} */
export async function GET(
  request: Request,
  context: { params: Promise<{ importId: string }> },
) {
  try {
    const principal = await requireApiPrincipal(
      request,
      "catalog:read",
      "import:read",
    );
    const { importId } = await context.params;
    return json(
      importResource(await getImport(principal, importId)),
      principal,
    );
  } catch (error) {
    return problem(error, request);
  }
}
