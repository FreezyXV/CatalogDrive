import { z } from "zod";
import { requireIdentity } from "@/server/auth";
import { getFileStore } from "@/server/storage";
import { checkOrigin, errorResponse, HttpError, readJson } from "@/server/http";

export const runtime = "nodejs";

const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), bytes: z.number().int().positive() }),
  z.object({
    action: z.literal("part"),
    token: z.string().min(1),
    number: z.number().int().positive(),
  }),
  z.object({ action: z.literal("complete"), token: z.string().min(1) }),
  z.object({ action: z.literal("abort"), token: z.string().min(1) }),
]);

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const actor = await requireIdentity();
    const store = getFileStore();
    const body = command.parse(await readJson(request));
    if (
      !store.beginMultipartUpload ||
      !store.signMultipartPart ||
      !store.finishMultipartUpload ||
      !store.abortMultipartUpload
    )
      throw new HttpError(409, "Transfert multipart indisponible.");
    if (body.action === "start")
      return Response.json(
        await store.beginMultipartUpload(actor.organizationId, body.bytes),
        { status: 201 },
      );
    if (body.action === "part")
      return Response.json({
        url: await store.signMultipartPart(
          actor.organizationId,
          body.token,
          body.number,
        ),
      });
    if (body.action === "complete")
      return Response.json({
        key: await store.finishMultipartUpload(
          actor.organizationId,
          body.token,
        ),
      });
    await store.abortMultipartUpload(actor.organizationId, body.token);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
