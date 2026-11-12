import { getImport } from "@/server/imports";
import { queueImport, runJob } from "@/server/catalog";
import { dispatchMode } from "@/server/integration/dispatch";
import { json, problem, requireApiPrincipal } from "@/server/api/v1";

export const maxDuration = 300;

/**
 * POST /api/v1/imports/{importId}/processing — 202 Accepted.
 * Queue mode: command in the outbox, routed by source format.
 * Inline mode: processed before answering (still 202, status is then final).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ importId: string }> },
) {
  try {
    const principal = await requireApiPrincipal(
      request,
      "catalog:write",
      "processing:start",
    );
    const { importId } = await context.params;
    const result = await queueImport(principal, importId, {
      correlationId: principal.correlationId,
    });
    if (result.queued && dispatchMode() === "inline")
      await runJob(importId).catch(() => undefined);
    const { job } = await getImport(principal, importId);
    return json(
      {
        importId,
        status: job.status,
        messageId: result.messageId,
        route: result.route,
      },
      principal,
      { status: 202, headers: { Location: `/api/v1/imports/${importId}` } },
    );
  } catch (error) {
    return problem(error, request);
  }
}
