import { z } from "zod";
import {
  authenticate,
  createSession,
  limitAuth,
  limitAuthNetwork,
  logout,
  registerAccount,
} from "@/server/auth";
import { checkOrigin, errorResponse, HttpError, readJson } from "@/server/http";
const credentials = z.object({
  email: z
    .email("Indiquez une adresse email valide.")
    .max(254)
    .transform((email) => email.toLowerCase()),
  password: z
    .string()
    .min(12, "Le mot de passe doit contenir au moins 12 caractères.")
    .max(128, "Le mot de passe est limité à 128 caractères."),
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
      await logout();
      return Response.json({ ok: true });
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
    return Response.json(
      { ok: true },
      { status: action === "register" ? 201 : 200 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
