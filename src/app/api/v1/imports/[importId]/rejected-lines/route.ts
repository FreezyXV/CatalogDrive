import { z } from "zod";
import { getImport } from "@/server/imports";
import {
  ApiError,
  json,
  problem,
  rejectedLines,
  requireApiPrincipal,
} from "@/server/api/v1";

/** GET /api/v1/imports/{importId}/rejected-lines?page=1 */
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
    const page = z.coerce
      .number()
      .int()
      .min(1)
      .max(10000)
      .parse(new URL(request.url).searchParams.get("page") ?? 1);
    const { job } = await getImport(principal, importId);
    if (job.status !== "ready")
      throw new ApiError(409, "Le traitement n’est pas terminé.");
    return json(
      await rejectedLines(principal.organizationId, importId, page),
      principal,
    );
  } catch (error) {
    return problem(error, request);
  }
}
