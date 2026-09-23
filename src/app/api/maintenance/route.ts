import { purgeExpiredImports } from "@/server/imports";
import { getFileStore } from "@/server/storage";
import { errorResponse, HttpError } from "@/server/http";
export const maxDuration = 300;
export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
      throw new HttpError(401, "Tâche non autorisée.");
    const store = getFileStore();
    const deleted = await purgeExpiredImports(store);
    const abandonedUploads = await store.cleanupAbandonedMultipartUploads?.();
    return Response.json({ deleted, abandonedUploads: abandonedUploads ?? 0 });
  } catch (error) {
    return errorResponse(error);
  }
}
