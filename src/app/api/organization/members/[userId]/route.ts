import { z } from "zod";
import { requireIdentity } from "@/server/auth";
import { authorize } from "@/server/auth/rbac";
import { roleSchema } from "@/server/auth/schemas";
import { checkOrigin, errorResponse, readJson } from "@/server/http";
import { removeMember, updateMemberRole } from "@/server/team";

type Context = { params: Promise<{ userId: string }> };
const schema = z.object({ role: roleSchema });

async function target(request: Request, context: Context) {
  checkOrigin(request);
  const actor = await requireIdentity();
  authorize(actor, "organization:manage");
  return { actor, userId: z.uuid().parse((await context.params).userId) };
}
export async function PATCH(request: Request, context: Context) {
  try {
    const { actor, userId } = await target(request, context);
    const { role } = schema.parse(await readJson(request));
    await updateMemberRole(actor, userId, role);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
export async function DELETE(request: Request, context: Context) {
  try {
    const { actor, userId } = await target(request, context);
    await removeMember(actor, userId);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
