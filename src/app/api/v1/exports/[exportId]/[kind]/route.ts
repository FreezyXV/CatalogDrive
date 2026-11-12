import { Readable } from "node:stream";
import { z } from "zod";
import { getExport } from "@/server/exports";
import { getFileStore } from "@/server/storage";
import { ApiError, problem, requireApiPrincipal } from "@/server/api/v1";

/** GET /api/v1/exports/{exportId}/{file|report} */
export async function GET(
  request: Request,
  context: { params: Promise<{ exportId: string; kind: string }> },
) {
  try {
    const principal = await requireApiPrincipal(
      request,
      "catalog:read",
      "import:read",
    );
    const { exportId, kind } = await context.params;
    if (
      !z.uuid().safeParse(exportId).success ||
      !["file", "report"].includes(kind)
    )
      throw new ApiError(404, "Export introuvable.");
    const exported = await getExport(principal, exportId);
    const store = getFileStore();
    const key = kind === "file" ? exported.storageKey : exported.reportKey;
    const filename = `catamotive-${kind}-${exportId}.csv`;
    if (store.signedUrl)
      return new Response(null, {
        status: 302,
        headers: {
          Location: await store.signedUrl(key, filename),
          "X-Correlation-ID": principal.correlationId,
        },
      });
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
        "X-Correlation-ID": principal.correlationId,
      },
    });
  } catch (error) {
    return problem(error, request);
  }
}
