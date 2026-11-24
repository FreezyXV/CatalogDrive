import { z } from "zod";
import { requireIdentity } from "@/server/auth";
import { authorize } from "@/server/auth/rbac";
import { checkOrigin, errorResponse } from "@/server/http";
import { revokeInvitation } from "@/server/team";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    checkOrigin(request);
    const actor = await requireIdentity();
    authorize(actor, "organization:manage");
    const id = z.uuid().parse((await context.params).id);
    await revokeInvitation(actor, id);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
