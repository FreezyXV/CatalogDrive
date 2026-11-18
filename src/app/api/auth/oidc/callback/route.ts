import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createSession } from "@/server/auth";
import {
  discover,
  provisionPrincipal,
  requireOidcConfig,
  verifyJwt,
} from "@/server/auth/oidc";
import { HttpError } from "@/server/http";

const OIDC_COOKIE = "catamotive_oidc";
const pending = z.object({
  state: z.string().min(16),
  nonce: z.string().min(16),
  verifier: z.string().min(43),
});
function same(a: string, b: string) {
  const received = Buffer.from(a);
  const expected = Buffer.from(b);
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

/**
 * Redirect URI of the Authorization Code flow: checks `state`, exchanges the
 * code with the PKCE verifier, verifies the ID token (signature, issuer,
 * audience, nonce), provisions the user and opens an application session.
 */
export async function GET(request: Request) {
  let destination = "/dashboard";
  try {
    const config = requireOidcConfig();
    const params = new URL(request.url).searchParams;
    const jar = await cookies();
    const value = jar.get(OIDC_COOKIE)?.value;
    jar.set(OIDC_COOKIE, "", { path: "/api/auth/oidc", maxAge: 0 });
    const saved = pending.safeParse(JSON.parse(value ?? "null"));
    if (params.get("error"))
      throw new HttpError(
        401,
        "Connexion refusée par le fournisseur d’identité.",
      );
    const code = params.get("code");
    const state = params.get("state") ?? "";
    if (!saved.success || !code || !same(state, saved.data.state))
      throw new HttpError(400, "Session de connexion expirée. Recommencez.");

    const { token_endpoint } = await discover(config.issuer);
    const response = await fetch(token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(
          `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`,
        ).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
        code_verifier: saved.data.verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new HttpError(401, "Échange du code d’autorisation refusé.");
    const tokens = (await response.json()) as { id_token?: string };
    if (!tokens.id_token) throw new HttpError(401, "Jeton d’identité absent.");
    const claims = await verifyJwt(tokens.id_token, config.clientId, config);
    if (claims.nonce !== saved.data.nonce)
      throw new HttpError(401, "Nonce invalide.");

    const { user, granted } = await provisionPrincipal(claims, {
      groupsClaim: config.groupsClaim,
      selfSignup: config.selfSignup,
    });
    const [organizationId] = granted.keys();
    await createSession({ userId: user.id, organizationId });
  } catch (error) {
    const message =
      error instanceof HttpError
        ? error.message
        : "Connexion SSO impossible. Réessayez.";
    if (!(error instanceof HttpError))
      console.error(
        "Erreur OIDC",
        error instanceof Error ? error.name : "UnknownError",
      );
    destination = `/connexion?sso_error=${encodeURIComponent(message)}`;
  }
  redirect(destination);
}
