import { z } from "zod";
import { requireIdentity } from "@/server/auth";
import { authorize } from "@/server/auth/rbac";
import { checkOrigin, errorResponse, readJson } from "@/server/http";
import { limitOrganizationAction } from "@/server/limits";
import { listSyncs, startSync } from "@/server/stores/sync";
import { syncOptionsSchema } from "@/domain/store-sync";

type Context = { params: Promise<{ id: string }> };

export async function GET(_: Request, context: Context) {
  try {
    const actor = await requireIdentity();
    const id = z.uuid().parse((await context.params).id);
    return Response.json(
      { syncs: await listSyncs(actor, id) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
/** Creates the sync; the client then drives it with POST /api/store-syncs/:id. */
export async function POST(request: Request, context: Context) {
  try {
    checkOrigin(request);
    const actor = await requireIdentity();
    authorize(actor, "export:create");
    await limitOrganizationAction(actor.organizationId, "store_sync");
    const id = z.uuid().parse((await context.params).id);
    const options = syncOptionsSchema.parse(await readJson(request));
    return Response.json(
      { sync: await startSync(actor, id, options) },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
