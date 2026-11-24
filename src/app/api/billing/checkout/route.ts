import { z } from "zod";
import { requireIdentity } from "@/server/auth";
import { authorize } from "@/server/auth/rbac";
import { checkOrigin, errorResponse, readJson } from "@/server/http";
import { createCheckout } from "@/server/billing/stripe";
import { PAID_PLAN_IDS } from "@/domain/plans";

export const runtime = "nodejs";
const payload = z.object({ plan: z.enum(PAID_PLAN_IDS) });

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const actor = await requireIdentity();
    authorize(actor, "organization:manage");
    const { plan } = payload.parse(await readJson(request));
    return Response.json(await createCheckout(actor, plan));
  } catch (error) {
    return errorResponse(error);
  }
}
