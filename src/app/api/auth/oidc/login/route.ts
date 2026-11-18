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
export async function GET(request: Request) {
  let target: string;
  try {
    const config = requireOidcConfig();
    const incoming = new URL(request.url);
    const canonical = new URL("/api/auth/oidc/login", config.redirectUri);
    if (incoming.origin !== canonical.origin) {
      canonical.search = incoming.search;
      return Response.redirect(canonical, 307);
    }
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
    const query = incoming.searchParams;
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
    // Social button: only an allow-listed connection is forwarded.
    const connection = config.connections.find(
      (c) => c.id === query.get("connection"),
    );
    if (connection) url.searchParams.set(config.connectionParam, connection.id);
    // Auth0 Universal Login opens on its sign-up tab.
    if (query.get("signup") === "1")
      url.searchParams.set("screen_hint", "signup");
    target = url.toString();
  } catch (error) {
    return errorResponse(error);
  }
  redirect(target);
}
