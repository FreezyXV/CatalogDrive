import { requireIdentity } from "@/server/auth";
import { getImport, removeImport } from "@/server/imports";
import { checkOrigin, errorResponse } from "@/server/http";
type Context = { params: Promise<{ id: string }> };
export async function GET(_: Request, context: Context) {
  try {
    const identity = await requireIdentity();
    const { job, file } = await getImport(identity, (await context.params).id);
    return Response.json(
      {
        id: job.id,
        diagnostic: job.diagnostic,
        filename: file.originalName,
        sha256: file.sha256,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function DELETE(request: Request, context: Context) {
  try {
    checkOrigin(request);
    const identity = await requireIdentity();
    await removeImport(identity, (await context.params).id);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
