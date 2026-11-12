import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  discover,
  loginChallenge,
  requireOidcConfig,
} from "@/server/auth/oidc";
import { errorResponse } from "@/server/http";

const OIDC_COOKIE = "catamotive_oidc";

/** Starts an Authorization Code + PKCE flow towards the identity provider. */
export async function GET() {
  let target: string;
  try {
    const config = requireOidcConfig();
    const { authorization_endpoint } = await discover(config.issuer);
    const login = loginChallenge();
    (await cookies()).set(
      OIDC_COOKIE,
      JSON.stringify({
        state: login.state,
        nonce: login.nonce,
        verifier: login.verifier,
      }),
      {
        httpOnly: true,
        // `lax` lets the IdP's top-level redirect carry the cookie back.
        sameSite: "lax",
        secure: process.env.COOKIE_SECURE === "true",
        path: "/api/auth/oidc",
        maxAge: 600,
      },
    );
    const url = new URL(authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: "openid profile email",
      state: login.state,
      nonce: login.nonce,
      code_challenge: login.challenge,
      code_challenge_method: "S256",
    }).toString();
    target = url.toString();
  } catch (error) {
    return errorResponse(error);
  }
  redirect(target);
}
