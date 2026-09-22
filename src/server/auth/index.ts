import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/server/db";
import {
  users,
  organizations,
  memberships,
  sessions,
  auditEvents,
  authAttempts,
} from "@/server/db/schema";
import { hashPassword, hashToken, verifyPassword } from "./password";
import { HttpError } from "@/server/http";
export const SESSION_COOKIE = "catamotive_session";
export type Identity = {
  userId: string;
  organizationId: string;
  email: string;
  organizationName: string;
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
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .innerJoin(organizations, eq(sessions.organizationId, organizations.id))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return identity ?? null;
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
  const [attempt] = await db
    .insert(authAttempts)
    .values({
      key: hashToken(email),
      count: 1,
      resetAt: new Date(Date.now() + 15 * 60_000),
    })
    .onConflictDoUpdate({
      target: authAttempts.key,
      set: {
        count: sql`CASE WHEN ${authAttempts.resetAt} < now() THEN 1 ELSE ${authAttempts.count} + 1 END`,
        resetAt: sql`CASE WHEN ${authAttempts.resetAt} < now() THEN now() + interval '15 minutes' ELSE ${authAttempts.resetAt} END`,
      },
    })
    .returning();
  if (attempt.count > 10)
    throw new HttpError(
      429,
      "Trop de tentatives pour cette adresse. Réessayez dans 15 minutes.",
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
      .values({ userId: user.id, organizationId: org.id });
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
    .where(eq(memberships.userId, user.id))
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
export async function logout() {
  const identity = await currentIdentity();
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
}
