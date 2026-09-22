import { requireIdentity } from "@/server/auth";
import { importCsv, importSignedUpload } from "@/server/imports";
import { checkOrigin, errorResponse, HttpError, readJson } from "@/server/http";
import { LIMITS } from "@/domain/csv";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const identity = await requireIdentity();
    if (request.headers.get("content-type")?.includes("application/json")) {
      const body = (await readJson(request)) as {
        key?: string;
        filename?: string;
      };
      if (!body.key || !body.filename)
        throw new HttpError(400, "Upload incomplet.");
      return Response.json(
        { id: await importSignedUpload(identity, body.filename, body.key) },
        { status: 201 },
      );
    }
    if (Number(request.headers.get("content-length") || 0) > LIMITS.bytes)
      throw new HttpError(413, "Le fichier dépasse la limite de 5 Mio.");
    let filename: string;
    try {
      filename = decodeURIComponent(request.headers.get("x-file-name") ?? "");
    } catch {
      throw new HttpError(400, "Nom de fichier invalide.");
    }
    if (!request.body) throw new HttpError(400, "Choisissez un fichier CSV.");
    const id = await importCsv(identity, filename, request.body);
    return Response.json({ id }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
