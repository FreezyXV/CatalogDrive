import { API_VERSION } from "@/server/api/v1";
import { dispatchMode } from "@/server/integration/dispatch";

export const dynamic = "force-dynamic";

/** GET /api/v1/health — liveness probe used by the gateway (no authentication). */
export async function GET() {
  return Response.json(
    { status: "ok", version: API_VERSION, dispatch: dispatchMode() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
