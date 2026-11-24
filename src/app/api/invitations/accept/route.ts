import { z } from "zod";
import {
  createSession,
  currentIdentity,
  limitAuthNetwork,
} from "@/server/auth";
import { passwordSchema, tokenSchema } from "@/server/auth/schemas";
import { checkOrigin, errorResponse, readJson } from "@/server/http";
import { acceptInvitation } from "@/server/team";

const schema = z.object({
  token: tokenSchema,
  password: passwordSchema.optional(),
});

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { token, password } = schema.parse(await readJson(request));
    await limitAuthNetwork(request, "invitation");
    const actor = await acceptInvitation(token, {
      identity: await currentIdentity(),
      password,
    });
    await createSession(actor);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
