import { createHash, randomBytes } from "node:crypto";
import { and, eq, ne, notInArray } from "drizzle-orm";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { db } from "../db";
import {
  auditEvents,
  memberships,
  organizations,
  sessions,
  users,
} from "../db/schema";
import { HttpError } from "../http";
import { normalizeRole, type Role } from "./rbac";

/**
 * OpenID Connect integration (Keycloak or WSO2 Identity Server).
 *
 * - Browser: Authorization Code + PKCE (S256), state and nonce, MFA enforced
 *   by the identity provider's authentication flow.
 * - API: JWT access tokens verified locally against the provider's JWKS
 *   (signature, issuer, audience, expiry) — no call to the IdP per request.
 *
 * Organizations and roles travel in the `groups` claim:
 *   /organizations/<organization-uuid>/<admin|operator|reviewer>
 */
export type OidcConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  apiAudience: string;
};

export function oidcConfig(): OidcConfig | null {
  const issuer = process.env.OIDC_ISSUER?.replace(/\/$/, "");
  if (!issuer) return null;
  const origin = process.env.APP_ORIGIN ?? "http://127.0.0.1:3000";
  return {
    issuer,
    clientId: process.env.OIDC_CLIENT_ID ?? "catamotive-web",
    clientSecret: process.env.OIDC_CLIENT_SECRET ?? "",
    redirectUri:
      process.env.OIDC_REDIRECT_URI ?? `${origin}/api/auth/oidc/callback`,
    apiAudience: process.env.OIDC_API_AUDIENCE ?? "catamotive-api",
  };
}

export function requireOidcConfig() {
  const config = oidcConfig();
  if (!config)
    throw new HttpError(404, "La connexion SSO n’est pas configurée.");
  return config;
}

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
};
const discoveries = new Map<string, Promise<Discovery>>();
const keySets = new Map<string, JWTVerifyGetKey>();

export function discover(issuer: string) {
  let pending = discoveries.get(issuer);
  if (!pending) {
    pending = fetch(`${issuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(5000),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`OIDC discovery ${response.status}`);
      const document = (await response.json()) as Discovery;
      if (document.issuer !== issuer)
        throw new Error("OIDC discovery: issuer inattendu");
      return document;
    });
    pending.catch(() => discoveries.delete(issuer));
    discoveries.set(issuer, pending);
  }
  return pending;
}

async function keySet(issuer: string) {
  let keys = keySets.get(issuer);
  if (!keys) {
    const { jwks_uri } = await discover(issuer);
    // Cached and refreshed on unknown `kid` (key rotation) by jose.
    keys = createRemoteJWKSet(new URL(jwks_uri), { cooldownDuration: 30_000 });
    keySets.set(issuer, keys);
  }
  return keys;
}

export type TokenClaims = JWTPayload & {
  scope?: string;
  groups?: string[];
  email?: string;
  email_verified?: boolean;
  azp?: string;
  nonce?: string;
  preferred_username?: string;
};

/** Verifies signature, issuer, audience and lifetime of a JWT. */
export async function verifyJwt(
  token: string,
  audience: string,
  config: OidcConfig = requireOidcConfig(),
) {
  const { payload } = await jwtVerify(token, await keySet(config.issuer), {
    issuer: config.issuer,
    audience,
    algorithms: ["RS256", "PS256", "ES256"],
    clockTolerance: 30,
  });
  return payload as TokenClaims;
}

const GROUP_PATTERN =
  /^\/organizations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(admin|operator|reviewer)$/i;
const RANK: Record<Role, number> = { reviewer: 1, operator: 2, admin: 3 };

/** One entry per organization, keeping the highest role if several are present. */
export function membershipsFromGroups(groups: unknown) {
  const result = new Map<string, Role>();
  if (!Array.isArray(groups)) return result;
  for (const group of groups) {
    const match = typeof group === "string" ? GROUP_PATTERN.exec(group) : null;
    if (!match) continue;
    const organizationId = match[1].toLowerCase();
    const role = normalizeRole(match[2].toLowerCase());
    const current = result.get(organizationId);
    if (!current || RANK[role] > RANK[current])
      result.set(organizationId, role);
  }
  return result;
}

export function scopesOf(claims: TokenClaims) {
  return new Set((claims.scope ?? "").split(" ").filter(Boolean));
}

/**
 * Just-in-time provisioning: the identity provider is the source of truth
 * for who belongs to which organization with which role. Each login (or
 * first API call of a service account) synchronises the local copy.
 * Organizations missing from the token are revoked locally and their
 * sessions closed (leaver process).
 */
export async function provisionPrincipal(claims: TokenClaims) {
  if (!claims.sub) throw new HttpError(401, "Jeton sans sujet.");
  const granted = membershipsFromGroups(claims.groups);
  if (!granted.size)
    throw new HttpError(
      403,
      "Votre compte n’est rattaché à aucune organisation CataMotive.",
    );
  const email = (
    claims.email && claims.email_verified !== false
      ? claims.email
      : `${claims.azp ?? "client"}.${claims.sub}@clients.catamotive.invalid`
  ).toLowerCase();
  return db.transaction(async (tx) => {
    let [user] = await tx
      .select()
      .from(users)
      .where(eq(users.oidcSubject, claims.sub!))
      .limit(1);
    if (!user) {
      // Link an existing local account only when the IdP vouches for the email.
      const [byEmail] = claims.email_verified
        ? await tx.select().from(users).where(eq(users.email, email)).limit(1)
        : [];
      if (byEmail && !byEmail.oidcSubject) {
        [user] = await tx
          .update(users)
          .set({ oidcSubject: claims.sub })
          .where(eq(users.id, byEmail.id))
          .returning();
      } else {
        [user] = await tx
          .insert(users)
          .values({
            email,
            oidcSubject: claims.sub,
            // Not a scrypt hash: password login is impossible for this account.
            passwordHash: `oidc:${claims.sub}`,
            emailVerifiedAt: claims.email_verified ? new Date() : null,
          })
          .returning();
      }
    }
    for (const [organizationId, role] of granted) {
      await tx
        .insert(organizations)
        .values({
          id: organizationId,
          name: `Organisation ${organizationId.slice(0, 8)}`,
        })
        .onConflictDoNothing();
      const [previous] = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, user.id),
            eq(memberships.organizationId, organizationId),
          ),
        );
      if (previous?.role === role) continue;
      await tx
        .insert(memberships)
        .values({ userId: user.id, organizationId, role })
        .onConflictDoUpdate({
          target: [memberships.userId, memberships.organizationId],
          set: { role },
        });
      await tx.insert(auditEvents).values({
        userId: user.id,
        organizationId,
        action: previous ? "membership.role_synced" : "membership.provisioned",
        entityId: user.id,
      });
    }
    // Revoke organizations the IdP no longer grants.
    const revoked = await tx
      .update(memberships)
      .set({ role: "revoked" })
      .where(
        and(
          eq(memberships.userId, user.id),
          ne(memberships.role, "revoked"),
          notInArray(memberships.organizationId, [...granted.keys()]),
        ),
      )
      .returning({ organizationId: memberships.organizationId });
    for (const { organizationId } of revoked)
      await tx
        .delete(sessions)
        .where(
          and(
            eq(sessions.userId, user.id),
            eq(sessions.organizationId, organizationId),
          ),
        );
    return { user, granted };
  });
}

/** PKCE (RFC 7636) and anti-CSRF values for one login attempt. */
export function loginChallenge() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    state: randomBytes(16).toString("base64url"),
    nonce: randomBytes(16).toString("base64url"),
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}
