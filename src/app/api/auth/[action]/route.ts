import { z } from "zod";
import {
  authenticate,
  createSession,
  limitAuth,
  limitAuthNetwork,
  logout,
  registerAccount,
} from "@/server/auth";
import { sendEmailVerification } from "@/server/auth/account";
import { emailSchema, passwordSchema } from "@/server/auth/schemas";
import { checkOrigin, errorResponse, HttpError, readJson } from "@/server/http";
const credentials = z.object({
  email: emailSchema,
  password: passwordSchema,
});
const registration = credentials.extend({
  organizationName: z
    .string()
    .trim()
    .min(2, "Indiquez le nom de votre organisation (2 caractères minimum).")
    .max(80),
});
export async function POST(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  try {
    checkOrigin(request);
    const { action } = await context.params;
    if (action === "logout") {
      const redirect = await logout();
      return Response.json({ ok: true, redirect });
    }
    if (action !== "login" && action !== "register")
      throw new HttpError(404, "Action inconnue.");
    const body = await readJson(request);
    const input = (action === "register" ? registration : credentials).parse(
      body,
    );
    await limitAuthNetwork(request, action);
    await limitAuth(input.email);
    const actor =
      action === "register"
        ? await registerAccount(
            input.email,
            input.password,
            registration.parse(body).organizationName,
          )
        : await authenticate(input.email, input.password);
    await createSession(actor);
    if (action === "register")
      // The account works right away; a mail outage must not block sign-up.
      await sendEmailVerification(actor.userId).catch((error: unknown) =>
        console.error(
          "Email de vérification non envoyé",
          error instanceof Error ? error.name : "UnknownError",
        ),
      );
    return Response.json(
      { ok: true },
      { status: action === "register" ? 201 : 200 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
