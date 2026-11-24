import { requireIdentity } from "@/server/auth";
import { authorize } from "@/server/auth/rbac";
import { checkOrigin, errorResponse, readJson } from "@/server/http";
import { limitOrganizationAction } from "@/server/limits";
import { createConnection, listConnections } from "@/server/stores/connections";
import { connectionInputSchema } from "@/domain/store-sync";

export async function GET() {
  try {
    const actor = await requireIdentity();
    return Response.json(
      { connections: await listConnections(actor) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const actor = await requireIdentity();
    authorize(actor, "store:manage");
    await limitOrganizationAction(actor.organizationId, "store_connection");
    const input = connectionInputSchema.parse(await readJson(request));
    return Response.json(
      { connection: await createConnection(actor, input) },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
