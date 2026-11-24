import { z } from "zod";
import { requireIdentity } from "@/server/auth";
import { authorize } from "@/server/auth/rbac";
import { checkOrigin, errorResponse } from "@/server/http";
import { limitOrganizationAction } from "@/server/limits";
import { removeConnection, testConnection } from "@/server/stores/connections";

type Context = { params: Promise<{ id: string }> };

/** Tests the connection again and refreshes the store settings. */
export async function POST(request: Request, context: Context) {
  try {
    checkOrigin(request);
    const actor = await requireIdentity();
    authorize(actor, "store:manage");
    await limitOrganizationAction(actor.organizationId, "store_connection");
    const id = z.uuid().parse((await context.params).id);
    return Response.json({ connection: await testConnection(actor, id) });
  } catch (error) {
    return errorResponse(error);
  }
}
export async function DELETE(request: Request, context: Context) {
  try {
    checkOrigin(request);
    const actor = await requireIdentity();
    authorize(actor, "store:manage");
    await removeConnection(actor, z.uuid().parse((await context.params).id));
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
