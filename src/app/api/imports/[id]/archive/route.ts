import { Readable } from "node:stream";
import { requireIdentity } from "@/server/auth";
import { getSourceArchiveForImport } from "@/server/imports";
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
    const archive = await getSourceArchiveForImport(
      identity,
      (await context.params).id,
    );
    const store = getFileStore();
    await store.sample(archive.storageKey);
    await db.insert(auditEvents).values({
      userId: identity.userId,
      organizationId: identity.organizationId,
      action: "archive.downloaded",
      entityId: archive.id,
    });
    if (store.signedUrl)
      return Response.redirect(
        await store.signedUrl(archive.storageKey, archive.originalName),
        302,
      );
    const filename = encodeURIComponent(archive.originalName).replace(
      /['()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return new Response(
      Readable.toWeb(store.read(archive.storageKey)) as ReadableStream,
      {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="archive.zip"; filename*=UTF-8''${filename}`,
          "Content-Length": String(archive.sizeBytes),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
