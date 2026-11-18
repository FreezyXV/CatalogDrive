import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, ne, notInArray } from "drizzle-orm";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { db, lockTransaction } from "../db";
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
  /** Issuer without trailing slash, used to build the discovery URL. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  apiAudience: string;
  /** Claim holding `/organizations/<id>/<role>` paths (Auth0 needs a namespaced claim). */
  groupsClaim: string;
  /** Sign-in without organization groups creates a personal organization. */
  selfSignup: boolean;
  /** Buttons that send the user straight to one upstream provider (Google…). */
  connections: SocialConnection[];
  /** Authorization parameter carrying the connection: Auth0 `connection`, Keycloak `kc_idp_hint`. */
  connectionParam: string;
};
export type SocialConnection = { id: string; label: string };

/** `google-oauth2:Google,windowslive:Microsoft` → [{id, label}, …] */
export function parseConnections(raw: string | undefined): SocialConnection[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, label] = entry.split(":");
      return { id: id.trim(), label: (label ?? id).trim() };
    })
    .filter((c) => /^[A-Za-z0-9._-]{1,64}$/.test(c.id))
    .slice(0, 6);
}

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
    groupsClaim: process.env.OIDC_GROUPS_CLAIM ?? "groups",
    selfSignup: process.env.OIDC_SELF_SIGNUP !== "false",
    connections: parseConnections(process.env.OIDC_SOCIAL_CONNECTIONS),
    connectionParam: process.env.OIDC_CONNECTION_PARAM ?? "connection",
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
      if (document.issuer.replace(/\/$/, "") !== issuer)
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
  name?: string;
  preferred_username?: string;
};

/** Verifies signature, issuer, audience and lifetime of a JWT. */
export async function verifyJwt(
  token: string,
  audience: string,
  config: OidcConfig = requireOidcConfig(),
) {
  // The exact issuer string comes from discovery: Auth0's ends with "/".
  const { issuer } = await discover(config.issuer);
  const { payload } = await jwtVerify(token, await keySet(config.issuer), {
    issuer,
    audience,
    algorithms: ["RS256", "PS256", "ES256"],
    clockTolerance: 30,
    requiredClaims: ["sub", "exp"],
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
  return new Set(
    typeof claims.scope === "string"
      ? claims.scope.split(/\s+/).filter(Boolean)
      : [],
  );
}

/**
 * Just-in-time provisioning: the identity provider is the source of truth
 * for who belongs to which organization with which role. Each login (or
 * first API call of a service account) synchronises the local copy.
 * Organizations missing from the token are revoked locally and their
 * sessions closed (leaver process).
 */
export type ProvisionOptions = {
  /** Claim to read the organization groups from. */
  groupsClaim?: string;
  /**
   * Browser sign-in only: a person whose token carries no organization
   * groups (Google, Auth0 social login…) gets or keeps a personal
   * organization where they are admin. Machine clients never self-sign-up.
   */
  selfSignup?: boolean;
};

export function organizationNameFor(claims: TokenClaims) {
  const name =
    (typeof claims.name === "string" && claims.name.trim()) ||
    (claims.email ?? "").split("@")[0] ||
    "nouvel utilisateur";
  return `Espace de ${name}`.slice(0, 80);
}

export async function provisionPrincipal(
  claims: TokenClaims,
  options: ProvisionOptions = {},
) {
  const subject = claims.sub;
  if (typeof subject !== "string" || !subject || subject.length > 255)
    throw new HttpError(401, "Sujet du jeton invalide.");
  const granted = membershipsFromGroups(
    (claims as Record<string, unknown>)[options.groupsClaim ?? "groups"],
  );
  const verifiedEmail =
    claims.email_verified === true && typeof claims.email === "string"
      ? claims.email.trim().toLowerCase()
      : "";
  const hasGroups = granted.size > 0;
  const result = await db.transaction(async (tx) => {
    // Two concurrent callbacks for one subject must create one account and space.
    await lockTransaction(tx, "oidc:" + subject);
    let [user] = await tx
      .select()
      .from(users)
      .where(eq(users.oidcSubject, subject))
      .limit(1);
    if (!user) {
      if (!hasGroups && !options.selfSignup) return null;
      if (!hasGroups && !verifiedEmail)
        throw new HttpError(
          403,
          "Vérifiez votre adresse email auprès de votre fournisseur de connexion.",
        );
      [user] = await tx
        .insert(users)
        .values({
          email:
            verifiedEmail ||
            `client.${createHash("sha256").update(subject).digest("hex")}@clients.catamotive.invalid`,
          oidcSubject: subject,
          passwordHash: `oidc:${subject}`,
          emailVerifiedAt: verifiedEmail ? new Date() : null,
        })
        .onConflictDoNothing({ target: users.email })
        .returning();
      if (!user)
        throw new HttpError(
          409,
          "Un compte utilise déjà cette adresse. Connectez-vous avec votre méthode habituelle.",
        );
    }
    // Revoke only grants supplied by the IdP, including loss of the last group.
    const revoked = await tx
      .update(memberships)
      .set({ role: "revoked" })
      .where(
        and(
          eq(memberships.userId, user.id),
          eq(memberships.managedByOidc, true),
          ne(memberships.role, "revoked"),
          granted.size
            ? notInArray(memberships.organizationId, [...granted.keys()])
            : undefined,
        ),
      )
      .returning({ organizationId: memberships.organizationId });
    if (revoked.length)
      await tx.delete(sessions).where(
        and(
          eq(sessions.userId, user.id),
          inArray(
            sessions.organizationId,
            revoked.map(({ organizationId }) => organizationId),
          ),
        ),
      );
    if (!hasGroups) {
      if (!options.selfSignup) return null;
      const own = await tx
        .select({
          organizationId: memberships.organizationId,
          role: memberships.role,
          managedByOidc: memberships.managedByOidc,
        })
        .from(memberships)
        .where(eq(memberships.userId, user.id));
      for (const m of own) {
        if (!m.managedByOidc && m.role !== "revoked")
          granted.set(m.organizationId, normalizeRole(m.role));
      }
      if (!granted.size) {
        if (own.length) return null;
        const [organization] = await tx
          .insert(organizations)
          .values({ name: organizationNameFor(claims) })
          .returning();
        await tx.insert(memberships).values({
          userId: user.id,
          organizationId: organization.id,
          role: "admin",
        });
        await tx.insert(auditEvents).values({
          userId: user.id,
          organizationId: organization.id,
          action: "organization.self_signup",
          entityId: organization.id,
        });
        granted.set(organization.id, "admin");
      }
      return { user, granted };
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
        .select({
          role: memberships.role,
          managedByOidc: memberships.managedByOidc,
        })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, user.id),
            eq(memberships.organizationId, organizationId),
          ),
        );
      if (previous?.role === role && previous.managedByOidc) continue;
      await tx
        .insert(memberships)
        .values({ userId: user.id, organizationId, role, managedByOidc: true })
        .onConflictDoUpdate({
          target: [memberships.userId, memberships.organizationId],
          set: { role, managedByOidc: true },
        });
      await tx.insert(auditEvents).values({
        userId: user.id,
        organizationId,
        action: previous ? "membership.role_synced" : "membership.provisioned",
        entityId: user.id,
      });
    }
    return { user, granted };
  });
  if (!result)
    throw new HttpError(
      403,
      "Votre compte n’est rattaché à aucune organisation CataMotive.",
    );
  return result;
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
