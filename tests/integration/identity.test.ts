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
import { authenticate, registerAccount } from "../../src/server/auth";
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

  it("inscription libre (Google via Auth0) : organisation personnelle admin, sans doublon", async () => {
    const socialSub = `google-oauth2|${randomUUID()}`;
    const claims = {
      sub: socialSub,
      email: `social-${randomUUID()}@example.test`,
      email_verified: true,
      name: "Ivan Test",
    };
    await expect(provisionPrincipal(claims)).rejects.toMatchObject({
      status: 403,
    });
    const [first, concurrent] = await Promise.all([
      provisionPrincipal(claims, { selfSignup: true }),
      provisionPrincipal(claims, { selfSignup: true }),
    ]);
    const [[orgId, role]] = [...first.granted];
    expect(role).toBe("admin");
    expect(concurrent.user.id).toBe(first.user.id);
    expect([...concurrent.granted.keys()]).toEqual([orgId]);
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId));
    expect(org.name).toBe("Espace de Ivan Test");
    const again = await provisionPrincipal(claims, { selfSignup: true });
    expect([...again.granted.keys()]).toEqual([orgId]);
    expect(
      await db
        .select()
        .from(memberships)
        .where(eq(memberships.userId, first.user.id)),
    ).toHaveLength(1);
    await db.delete(sessions).where(eq(sessions.userId, first.user.id));
    await db.delete(auditEvents).where(eq(auditEvents.userId, first.user.id));
    await db.delete(memberships).where(eq(memberships.userId, first.user.id));
    await db.delete(users).where(eq(users.id, first.user.id));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  it("révoque aussi le dernier groupe et ferme sa session", async () => {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.oidcSubject, sub));
    await db.insert(sessions).values({
      tokenHash: hashToken(randomUUID()),
      userId: user.id,
      organizationId: orgA,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      provisionPrincipal(
        { sub, email, email_verified: true },
        { selfSignup: true },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await db.select().from(sessions).where(eq(sessions.userId, user.id)),
    ).toHaveLength(0);
    const grants = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, user.id));
    expect(grants).toHaveLength(2);
    expect(grants.every(({ role }) => role === "revoked")).toBe(true);
  });

  it("lit les groupes dans un claim personnalisé (Action Auth0)", async () => {
    const { granted } = await provisionPrincipal(
      {
        sub,
        email,
        email_verified: true,
        "https://catamotive.app/groups": [`/organizations/${orgA}/operator`],
      } as Parameters<typeof provisionPrincipal>[0],
      { groupsClaim: "https://catamotive.app/groups" },
    );
    expect(Object.fromEntries(granted)).toEqual({ [orgA]: "operator" });
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

  it("refuse l’inscription sociale sans email vérifié ou avec un email déjà attribué", async () => {
    const localEmail = `local-${randomUUID()}@example.test`;
    const password = "mot-de-passe-local-de-test";
    const actor = await registerAccount(localEmail, password, "Compte local");
    const subject = randomUUID();
    try {
      await expect(
        provisionPrincipal(
          { sub: subject, email: localEmail },
          { selfSignup: true },
        ),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        provisionPrincipal(
          { sub: subject, email: localEmail, email_verified: true },
          { selfSignup: true },
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(await authenticate(localEmail, password)).toEqual(actor);
      expect(
        await db.select().from(users).where(eq(users.oidcSubject, subject)),
      ).toHaveLength(0);
    } finally {
      await db.delete(auditEvents).where(eq(auditEvents.userId, actor.userId));
      await db.delete(memberships).where(eq(memberships.userId, actor.userId));
      await db.delete(users).where(eq(users.id, actor.userId));
      await db
        .delete(organizations)
        .where(eq(organizations.id, actor.organizationId));
    }
  });
});
