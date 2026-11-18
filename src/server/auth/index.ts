import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt, ne } from "drizzle-orm";
import { db } from "@/server/db";
import {
  users,
  organizations,
  memberships,
  sessions,
  auditEvents,
} from "@/server/db/schema";
import { hashPassword, hashToken, verifyPassword } from "./password";
import { HttpError } from "@/server/http";
import { limitAttempts } from "../limits";
import { normalizeRole, type Role } from "./rbac";
import { discover, oidcConfig } from "./oidc";
export const SESSION_COOKIE = "catamotive_session";
export type Identity = {
  userId: string;
  organizationId: string;
  email: string;
  organizationName: string;
  role: Role;
};
export async function currentIdentity(): Promise<Identity | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const [identity] = await db
    .select({
      userId: users.id,
      organizationId: organizations.id,
      email: users.email,
      organizationName: organizations.name,
      role: memberships.role,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .innerJoin(organizations, eq(sessions.organizationId, organizations.id))
    .innerJoin(
      memberships,
      and(
        eq(memberships.userId, sessions.userId),
        eq(memberships.organizationId, sessions.organizationId),
      ),
    )
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        gt(sessions.expiresAt, new Date()),
        ne(memberships.role, "revoked"),
      ),
    )
    .limit(1);
  return identity ? { ...identity, role: normalizeRole(identity.role) } : null;
}
export async function requireIdentity() {
  const identity = await currentIdentity();
  if (!identity)
    throw new HttpError(
      401,
      "Connectez-vous pour accéder à votre organisation.",
    );
  return identity;
}
export async function requirePageIdentity() {
  const identity = await currentIdentity();
  if (!identity) redirect("/connexion");
  return identity;
}
export async function limitAuth(email: string) {
  await limitAttempts(
    hashToken(email),
    10,
    15,
    "Trop de tentatives pour cette adresse. Réessayez dans 15 minutes.",
  );
}
export function networkAttemptKey(
  request: Request,
  action: "login" | "register",
) {
  // Vercel replaces this header at its edge. Ignore caller-supplied headers
  // when the app runs locally or outside that trusted proxy.
  if (process.env.VERCEL !== "1") return null;
  const candidate = request.headers
    .get("x-vercel-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  const ip = candidate && isIP(candidate) ? candidate : "unknown";
  return hashToken(`${action}:network:${ip}`);
}
export async function limitAuthNetwork(
  request: Request,
  action: "login" | "register",
) {
  const key = networkAttemptKey(request, action);
  if (!key) return;
  const maximum = action === "register" ? 10 : 60;
  await limitAttempts(
    key,
    maximum,
    60,
    "Trop de tentatives depuis ce réseau. Réessayez dans une heure.",
  );
}
export async function registerAccount(
  email: string,
  password: string,
  organizationName: string,
) {
  const passwordHash = await hashPassword(password);
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ email, passwordHash })
      .onConflictDoNothing()
      .returning();
    if (!user)
      throw new HttpError(
        409,
        "Inscription impossible avec cette adresse. Essayez de vous connecter.",
      );
    const [org] = await tx
      .insert(organizations)
      .values({ name: organizationName })
      .returning();
    await tx
      .insert(memberships)
      .values({ userId: user.id, organizationId: org.id, role: "admin" });
    await tx.insert(auditEvents).values({
      userId: user.id,
      organizationId: org.id,
      action: "organization.created",
      entityId: org.id,
    });
    return { userId: user.id, organizationId: org.id };
  });
}
export async function authenticate(email: string, password: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  // Run a real scrypt even for an unknown account to reduce timing differences.
  const valid = await verifyPassword(
    password,
    user?.passwordHash ?? `scrypt:${"0".repeat(32)}:${"0".repeat(128)}`,
  );
  if (!user || !valid)
    throw new HttpError(401, "Adresse email ou mot de passe incorrect.");
  const [membership] = await db
    .select()
    .from(memberships)
    .where(
      and(eq(memberships.userId, user.id), ne(memberships.role, "revoked")),
    )
    .limit(1);
  if (!membership) throw new HttpError(403, "Aucune organisation accessible.");
  return { userId: user.id, organizationId: membership.organizationId };
}
export async function createSession(identity: {
  userId: string;
  organizationId: string;
}) {
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60_000);
  const jar = await cookies();
  const previous = jar.get(SESSION_COOKIE)?.value;
  await db.transaction(async (tx) => {
    if (previous)
      await tx
        .delete(sessions)
        .where(eq(sessions.tokenHash, hashToken(previous)));
    await tx
      .insert(sessions)
      .values({ ...identity, tokenHash: hashToken(token), expiresAt: expires });
    await tx.insert(auditEvents).values({
      ...identity,
      action: "session.created",
      entityId: identity.userId,
    });
  });
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true",
    path: "/",
    expires,
  });
}
/** Returns the identity provider logout URL when the account is an SSO account. */
export async function logout(): Promise<string | null> {
  const identity = await currentIdentity();
  const [account] = identity
    ? await db
        .select({ oidcSubject: users.oidcSubject })
        .from(users)
        .where(eq(users.id, identity.userId))
    : [];
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token)
    await db.transaction(async (tx) => {
      await tx.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
      if (identity)
        await tx.insert(auditEvents).values({
          userId: identity.userId,
          organizationId: identity.organizationId,
          entityId: identity.userId,
          action: "session.deleted",
        });
    });
  jar.delete(SESSION_COOKIE);
  return account?.oidcSubject ? ssoLogoutUrl() : null;
}
async function ssoLogoutUrl() {
  const config = oidcConfig();
  if (!config) return null;
  const discovery = await discover(config.issuer).catch(() => null);
  if (!discovery?.end_session_endpoint) return null;
  const url = new URL(discovery.end_session_endpoint);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    post_logout_redirect_uri: `${process.env.APP_ORIGIN ?? "http://127.0.0.1:3000"}/connexion`,
  }).toString();
  return url.toString();
}
