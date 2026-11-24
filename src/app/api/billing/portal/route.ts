import { requireIdentity } from "@/server/auth";
import { authorize } from "@/server/auth/rbac";
import { checkOrigin, errorResponse } from "@/server/http";
import { createPortal } from "@/server/billing/stripe";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const actor = await requireIdentity();
    authorize(actor, "organization:manage");
    return Response.json({ url: await createPortal(actor) });
  } catch (error) {
    return errorResponse(error);
  }
}
