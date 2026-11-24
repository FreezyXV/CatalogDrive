import { z } from "zod";
import { requireIdentity, switchOrganization } from "@/server/auth";
import { checkOrigin, errorResponse, readJson } from "@/server/http";

const schema = z.object({ organizationId: z.uuid() });

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const actor = await requireIdentity();
    const { organizationId } = schema.parse(await readJson(request));
    await switchOrganization(actor, organizationId);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
