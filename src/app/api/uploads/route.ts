import { z } from "zod";
import { requireIdentity } from "@/server/auth";
import { authorize } from "@/server/auth/rbac";
import { getFileStore, MULTIPART_PART_BYTES } from "@/server/storage";
import { checkOrigin, errorResponse, HttpError, readJson } from "@/server/http";
import { limitOrganizationAction } from "@/server/limits";

const payload = z.object({
  bytes: z.number().int().min(1).max(MULTIPART_PART_BYTES),
});
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const actor = await requireIdentity();
    authorize(actor, "import:create");
    const store = getFileStore();
    if (!store.signedUpload)
      throw new HttpError(
        409,
        "Upload direct indisponible avec le stockage local.",
      );
    const { bytes } = payload.parse(await readJson(request));
    await limitOrganizationAction(actor.organizationId, "upload");
    return Response.json(
      await store.signedUpload(actor.organizationId, bytes),
      {
        status: 201,
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
