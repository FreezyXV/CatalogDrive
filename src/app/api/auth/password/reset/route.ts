import { z } from "zod";
import { resetPassword } from "@/server/auth/account";
import { passwordSchema, tokenSchema } from "@/server/auth/schemas";
import { checkOrigin, errorResponse, readJson } from "@/server/http";

const schema = z.object({ token: tokenSchema, password: passwordSchema });

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { token, password } = schema.parse(await readJson(request));
    await resetPassword(token, password);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
