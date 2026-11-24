import { z } from "zod";
import { getImport, importCsv, listImports } from "@/server/imports";
import {
  importResource,
  json,
  problem,
  requireApiPrincipal,
  ApiError,
} from "@/server/api/v1";
import { uploadLimitBytes, uploadLimitLabel } from "@/domain/upload-limit";
import { limitOrganizationAction } from "@/server/limits";
import { assertStorageQuota } from "@/server/billing/quotas";

export const runtime = "nodejs";
export const maxDuration = 300;

/** GET /api/v1/imports */
export async function GET(request: Request) {
  try {
    const principal = await requireApiPrincipal(
      request,
      "catalog:read",
      "import:read",
    );
    const items = await listImports(principal);
    return json({ items: items.map(importResource) }, principal);
  } catch (error) {
    return problem(error, request);
  }
}

const filename = z
  .string()
  .max(180)
  .regex(
    /^[^/\\]+\.(csv|tsv|txt|xls|xlsx|ods)$/i,
    "Paramètre filename requis (CSV, TSV, TXT, XLS, XLSX ou ODS).",
  );

/** POST /api/v1/imports?filename=... — body: the raw file (streamed). */
export async function POST(request: Request) {
  try {
    const principal = await requireApiPrincipal(
      request,
      "catalog:write",
      "import:create",
    );
    const name = filename.parse(
      new URL(request.url).searchParams.get("filename") ?? "",
    );
    if (Number(request.headers.get("content-length") || 0) > uploadLimitBytes())
      throw new ApiError(
        413,
        `Le fichier dépasse la limite de ${uploadLimitLabel()}.`,
      );
    if (!request.body) throw new ApiError(400, "Corps de requête vide.");
    await limitOrganizationAction(principal.organizationId, "import");
    await assertStorageQuota(
      principal.organizationId,
      Number(request.headers.get("content-length") || 0),
    );
    const id = await importCsv(principal, name, request.body);
    return json(importResource(await getImport(principal, id)), principal, {
      status: 201,
      headers: { Location: `/api/v1/imports/${id}` },
    });
  } catch (error) {
    return problem(error, request);
  }
}
