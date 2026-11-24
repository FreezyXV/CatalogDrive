import { requireIdentity } from "@/server/auth";
import { sendEmailVerification } from "@/server/auth/account";
import { checkOrigin, errorResponse, HttpError } from "@/server/http";
import { limitAttempts } from "@/server/limits";

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const actor = await requireIdentity();
    if (actor.emailVerified)
      throw new HttpError(409, "Votre adresse est déjà confirmée.");
    await limitAttempts(
      `email_verification:${actor.userId}`,
      3,
      60,
      "Trop d’envois. Réessayez dans une heure.",
    );
    const sent = await sendEmailVerification(actor.userId);
    if (!sent)
      throw new HttpError(
        409,
        "Cette adresse est gérée par votre fournisseur de connexion.",
      );
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
