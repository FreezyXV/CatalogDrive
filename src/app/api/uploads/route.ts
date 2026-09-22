import { requireIdentity } from "@/server/auth";
import { getFileStore } from "@/server/storage";
import { checkOrigin, errorResponse, HttpError } from "@/server/http";
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const actor = await requireIdentity();
    const store = getFileStore();
    if (!store.signedUpload)
      throw new HttpError(
        409,
        "Upload direct indisponible avec le stockage local.",
      );
    return Response.json(await store.signedUpload(actor.organizationId), {
      status: 201,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
