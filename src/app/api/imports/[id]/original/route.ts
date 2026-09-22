import { Readable } from "node:stream";
import { requireIdentity } from "@/server/auth";
import { getImport } from "@/server/imports";
import { getFileStore } from "@/server/storage";
import { db } from "@/server/db";
import { auditEvents } from "@/server/db/schema";
import { errorResponse } from "@/server/http";
export const runtime = "nodejs";
export async function GET(
  _: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const identity = await requireIdentity();
    const { job, file } = await getImport(identity, (await context.params).id);
    const store = getFileStore();
    await store.sample(file.storageKey);
    await db.insert(auditEvents).values({
      userId: identity.userId,
      organizationId: identity.organizationId,
      action: "original.downloaded",
      entityId: job.id,
    });
    const filename = encodeURIComponent(file.originalName).replace(
      /['()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    if (store.signedUrl)
      return Response.redirect(
        await store.signedUrl(file.storageKey, file.originalName),
        302,
      );
    return new Response(
      Readable.toWeb(store.read(file.storageKey)) as ReadableStream,
      {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="original.csv"; filename*=UTF-8''${filename}`,
          "Content-Length": String(file.sizeBytes),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
