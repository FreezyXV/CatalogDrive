import { z } from "zod";
import { limitAuthNetwork } from "@/server/auth";
import { requestPasswordReset } from "@/server/auth/account";
import { hashToken } from "@/server/auth/password";
import { emailSchema } from "@/server/auth/schemas";
import { checkOrigin, errorResponse, readJson } from "@/server/http";
import { limitAttempts } from "@/server/limits";

const schema = z.object({ email: emailSchema });

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { email } = schema.parse(await readJson(request));
    await limitAuthNetwork(request, "password_reset");
    await limitAttempts(
      hashToken(`password_reset:${email}`),
      3,
      15,
      "Trop de demandes pour cette adresse. Réessayez dans 15 minutes.",
    );
    await requestPasswordReset(email);
    // Same answer whether or not the address has an account.
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
