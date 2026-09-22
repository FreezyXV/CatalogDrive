import { z } from "zod";
import { Readable } from "node:stream";
import { requireIdentity } from "@/server/auth";
import { getExport } from "@/server/exports";
import { getFileStore } from "@/server/storage";
import { errorResponse, HttpError } from "@/server/http";
export async function GET(
  _: Request,
  context: { params: Promise<{ id: string; kind: string }> },
) {
  try {
    const actor = await requireIdentity();
    const { id, kind } = await context.params;
    if (!z.uuid().safeParse(id).success || !["file", "report"].includes(kind))
      throw new HttpError(404, "Export introuvable.");
    const exported = await getExport(actor, id);
    const store = getFileStore();
    const key = kind === "file" ? exported.storageKey : exported.reportKey;
    const filename = `catamotive-${kind}-${id}.csv`;
    if (store.signedUrl)
      return Response.redirect(await store.signedUrl(key, filename), 302);
    await store.sample(key);
    return new Response(Readable.toWeb(store.read(key)) as ReadableStream, {
      headers: {
        "Content-Type":
          "text/csv; charset=" +
          (kind === "report" || exported.config.encoding !== "windows-1252"
            ? "utf-8"
            : "windows-1252"),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
