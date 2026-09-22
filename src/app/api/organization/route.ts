import { z } from "zod";
import { requireIdentity } from "@/server/auth";
import { checkOrigin, errorResponse, readJson } from "@/server/http";
import { organizationSummary, updateOrganization } from "@/server/organization";

const updateSchema = z.object({
  name: z.string().trim().min(2).max(100),
  retentionDays: z.number().int().min(1).max(365),
});
export async function GET() {
  try {
    return Response.json(await organizationSummary(await requireIdentity()));
  } catch (error) {
    return errorResponse(error);
  }
}
export async function PATCH(request: Request) {
  try {
    checkOrigin(request);
    const actor = await requireIdentity();
    return Response.json(
      await updateOrganization(
        actor,
        updateSchema.parse(await readJson(request)),
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
