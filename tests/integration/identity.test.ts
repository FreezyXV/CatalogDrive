import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../../src/server/db";
import {
  auditEvents,
  memberships,
  organizations,
  sessions,
  users,
} from "../../src/server/db/schema";
import { provisionPrincipal } from "../../src/server/auth/oidc";
import { authenticate } from "../../src/server/auth";
import { hashToken } from "../../src/server/auth/password";

const orgA = randomUUID();
const orgB = randomUUID();
const sub = randomUUID();
const email = `sso-${sub}@example.test`;
const groups = (...entries: [string, string][]) =>
  entries.map(([org, role]) => `/organizations/${org}/${role}`);

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "drizzle" });
});
afterAll(async () => {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.oidcSubject, sub));
  if (user) {
    await db.delete(sessions).where(eq(sessions.userId, user.id));
    await db.delete(auditEvents).where(eq(auditEvents.userId, user.id));
    await db.delete(memberships).where(eq(memberships.userId, user.id));
    await db.delete(users).where(eq(users.id, user.id));
  }
  await db.delete(organizations).where(inArray(organizations.id, [orgA, orgB]));
  await sqlClient.end();
});

describe("provisionnement juste-à-temps depuis le fournisseur d’identité", () => {
  it("crée l’utilisateur, les organisations et les rôles du jeton", async () => {
    const { user, granted } = await provisionPrincipal({
      sub,
      email,
      email_verified: true,
      groups: groups([orgA, "operator"], [orgB, "reviewer"]),
    });
    expect(user.oidcSubject).toBe(sub);
    expect(user.passwordHash).toBe(`oidc:${sub}`);
    expect(Object.fromEntries(granted)).toEqual({
      [orgA]: "operator",
      [orgB]: "reviewer",
    });
    const rows = await db
      .select({ org: memberships.organizationId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, user.id));
    expect(rows).toHaveLength(2);
  });

  it("un compte SSO ne peut pas se connecter par mot de passe", async () => {
    await expect(authenticate(email, `oidc:${sub}`)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("synchronise le rôle et révoque l’organisation retirée (départ)", async () => {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.oidcSubject, sub));
    await db.insert(sessions).values({
      tokenHash: hashToken(randomUUID()),
      userId: user.id,
      organizationId: orgB,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await provisionPrincipal({
      sub,
      email,
      email_verified: true,
      groups: groups([orgA, "admin"]),
    });
    const rows = await db
      .select({ org: memberships.organizationId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, user.id));
    expect(Object.fromEntries(rows.map((r) => [r.org, r.role]))).toEqual({
      [orgA]: "admin",
      [orgB]: "revoked",
    });
    expect(
      await db
        .select()
        .from(sessions)
        .where(
          and(eq(sessions.userId, user.id), eq(sessions.organizationId, orgB)),
        ),
    ).toHaveLength(0);
    const audit = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.userId, user.id));
    expect(audit.map((a) => a.action)).toContain("membership.role_synced");
  });

  it("refuse un jeton sans organisation CataMotive", async () => {
    await expect(
      provisionPrincipal({ sub: randomUUID(), groups: ["/staff"] }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("ne lie pas un compte local sur la base d’un email non vérifié", async () => {
    const { user } = await provisionPrincipal({
      sub,
      email: "autre@example.test",
      email_verified: false,
      groups: groups([orgA, "admin"]),
    });
    // Same subject → same user; the unverified email is never used to match.
    expect(user.email).toBe(email);
  });
});
