import { z } from "zod";
import { requireIdentity } from "@/server/auth";
import { authorize } from "@/server/auth/rbac";
import { checkOrigin, errorResponse, readJson } from "@/server/http";
import { advanceSync, getSync, resumeSync } from "@/server/stores/sync";

type Context = { params: Promise<{ id: string }> };
/** Leaves a margin under maxDuration to commit the last batch. */
const ADVANCE_BUDGET_MS = 240_000;

export async function GET(_: Request, context: Context) {
  try {
    const actor = await requireIdentity();
    const id = z.uuid().parse((await context.params).id);
    return Response.json(
      { sync: await getSync(actor, id) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
/**
 * Advances the sync for up to ~4 minutes (Vercel has no background work),
 * or resumes a failed one with { "action": "resume" }.
 */
export async function POST(request: Request, context: Context) {
  try {
    checkOrigin(request);
    const actor = await requireIdentity();
    authorize(actor, "export:create");
    const id = z.uuid().parse((await context.params).id);
    const { action } = z
      .object({ action: z.enum(["advance", "resume"]).default("advance") })
      .parse(await readJson(request));
    if (action === "resume") await resumeSync(actor, id);
    else await getSync(actor, id);
    await advanceSync(id, Date.now() + ADVANCE_BUDGET_MS);
    return Response.json({ sync: await getSync(actor, id) });
  } catch (error) {
    return errorResponse(error);
  }
}
export const maxDuration = 300;
