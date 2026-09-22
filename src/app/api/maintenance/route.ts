import { purgeExpiredImports } from "@/server/imports";
import { errorResponse, HttpError } from "@/server/http";
export const maxDuration = 300;
export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
      throw new HttpError(401, "Tâche non autorisée.");
    return Response.json({ deleted: await purgeExpiredImports() });
  } catch (error) {
    return errorResponse(error);
  }
}
