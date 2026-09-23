import { requireIdentity } from "@/server/auth";
import {
  importCsv,
  importSignedUpload,
  importSignedArchive,
  importZip,
} from "@/server/imports";
import { checkOrigin, errorResponse, HttpError, readJson } from "@/server/http";
import { uploadLimitBytes, uploadLimitLabel } from "@/domain/upload-limit";
export const runtime = "nodejs";
export const maxDuration = 300;
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
      if (/\.zip$/i.test(body.filename)) {
        const ids = await importSignedArchive(
          identity,
          body.filename,
          body.key,
        );
        return Response.json(
          { id: ids[0], count: ids.length },
          { status: 201 },
        );
      }
      return Response.json(
        { id: await importSignedUpload(identity, body.filename, body.key) },
        { status: 201 },
      );
    }
    if (Number(request.headers.get("content-length") || 0) > uploadLimitBytes())
      throw new HttpError(
        413,
        `Le fichier dépasse la limite de ${uploadLimitLabel()}.`,
      );
    let filename: string;
    try {
      filename = decodeURIComponent(request.headers.get("x-file-name") ?? "");
    } catch {
      throw new HttpError(400, "Nom de fichier invalide.");
    }
    if (!request.body)
      throw new HttpError(400, "Choisissez un fichier CSV, XLSX ou ZIP.");
    if (/\.zip$/i.test(filename)) {
      const ids = await importZip(identity, filename, request.body);
      return Response.json({ id: ids[0], count: ids.length }, { status: 201 });
    }
    const id = await importCsv(identity, filename, request.body);
    return Response.json({ id }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
