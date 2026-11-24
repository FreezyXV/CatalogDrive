import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../../src/server/db";
import {
  accountTokens,
  auditEvents,
  invitations,
  memberships,
  organizations,
  sessions,
  users,
} from "../../src/server/db/schema";
import {
  authenticate,
  registerAccount,
  type Identity,
} from "../../src/server/auth";
import {
  requestPasswordReset,
  resetPassword,
  sendEmailVerification,
  verifyEmail,
} from "../../src/server/auth/account";
import { hashToken } from "../../src/server/auth/password";
import { sentMails } from "../../src/server/mail";
import {
  acceptInvitation,
  invitationByToken,
  inviteMember,
  removeMember,
  revokeInvitation,
  teamOverview,
  updateMemberRole,
} from "../../src/server/team";

process.env.MAIL_DRIVER = "memory";
const run = randomUUID().slice(0, 8);
const address = (name: string) => `${name}-${run}@example.test`;
const password = "correct horse battery";
const userIds: string[] = [];
const orgIds: string[] = [];

function lastLink(to: string) {
  const mail = [...sentMails()].reverse().find((m) => m.to === to);
  const match = mail?.text.match(/https?:\/\/\S+/);
  if (!match) throw new Error(`Aucun lien envoyé à ${to}`);
  return new URL(match[0]);
}
const tokenOf = (url: URL) =>
  url.searchParams.get("token") ??
  decodeURIComponent(url.pathname.split("/").pop()!);

async function register(name: string) {
  const email = address(name);
  const actor = await registerAccount(email, password, `Org ${name} ${run}`);
  userIds.push(actor.userId);
  orgIds.push(actor.organizationId);
  return { ...actor, email };
}
async function identityOf(
  userId: string,
  organizationId: string,
): Promise<Identity> {
  const [row] = await db
    .select({
      email: users.email,
      verified: users.emailVerifiedAt,
      role: memberships.role,
      organizationName: organizations.name,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.organizationId, organizationId),
      ),
    );
  return {
    userId,
    organizationId,
    email: row.email,
    organizationName: row.organizationName,
    role: row.role as Identity["role"],
    emailVerified: row.verified !== null,
    sso: false,
  };
}
async function userByEmail(email: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (user && !userIds.includes(user.id)) userIds.push(user.id);
  return user;
}
async function openSession(userId: string, organizationId: string) {
  await db.insert(sessions).values({
    tokenHash: hashToken(randomUUID()),
    userId,
    organizationId,
    expiresAt: new Date(Date.now() + 60_000),
  });
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "drizzle" });
});
beforeEach(() => {
  sentMails().length = 0;
});
afterAll(async () => {
  if (orgIds.length)
    await db
      .delete(invitations)
      .where(inArray(invitations.organizationId, orgIds));
  if (userIds.length) {
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
    await db.delete(auditEvents).where(inArray(auditEvents.userId, userIds));
    await db
      .delete(accountTokens)
      .where(inArray(accountTokens.userId, userIds));
    await db.delete(memberships).where(inArray(memberships.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
  if (orgIds.length)
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
  await sqlClient.end();
});

describe("vérification de l’adresse email", () => {
  it("envoie un lien à usage unique qui confirme l’adresse", async () => {
    const owner = await register("verify");
    expect(await sendEmailVerification(owner.userId)).toBe(true);
    const link = lastLink(owner.email);
    expect(link.pathname).toBe("/verifier-email");
    expect(await verifyEmail(tokenOf(link))).toBe(true);
    expect((await userByEmail(owner.email)).emailVerifiedAt).not.toBeNull();
    expect(await verifyEmail(tokenOf(link))).toBe(false);
    // Already verified: nothing more is sent.
    expect(await sendEmailVerification(owner.userId)).toBe(false);
  });

  it("un nouveau lien invalide le précédent", async () => {
    const owner = await register("verify-twice");
    await sendEmailVerification(owner.userId);
    const first = tokenOf(lastLink(owner.email));
    await sendEmailVerification(owner.userId);
    const second = tokenOf(lastLink(owner.email));
    expect(await verifyEmail(first)).toBe(false);
    expect(await verifyEmail(second)).toBe(true);
  });
});

describe("mot de passe oublié", () => {
  it("ne révèle pas les adresses inconnues", async () => {
    await expect(
      requestPasswordReset(address("nobody")),
    ).resolves.toBeUndefined();
    expect(sentMails()).toHaveLength(0);
  });

  it("réinitialise, ferme les sessions et refuse un lien réutilisé", async () => {
    const owner = await register("reset");
    await openSession(owner.userId, owner.organizationId);
    await requestPasswordReset(owner.email);
    const token = tokenOf(lastLink(owner.email));
    const updated = "un tout nouveau secret";
    await resetPassword(token, updated);
    await expect(authenticate(owner.email, password)).rejects.toMatchObject({
      status: 401,
    });
    await expect(authenticate(owner.email, updated)).resolves.toMatchObject({
      userId: owner.userId,
    });
    expect(
      await db.select().from(sessions).where(eq(sessions.userId, owner.userId)),
    ).toHaveLength(0);
    expect((await userByEmail(owner.email)).emailVerifiedAt).not.toBeNull();
    await expect(
      resetPassword(token, "encore un autre secret"),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("invitations d’équipe", () => {
  it("exige une adresse confirmée pour inviter", async () => {
    const owner = await register("unverified-admin");
    const actor = await identityOf(owner.userId, owner.organizationId);
    await expect(
      inviteMember(actor, { email: address("guest"), role: "operator" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("crée le compte de l’invité avec le rôle choisi, une seule fois", async () => {
    const owner = await register("team-admin");
    await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.id, owner.userId));
    const actor = await identityOf(owner.userId, owner.organizationId);
    const guest = address("new-guest");
    await inviteMember(actor, { email: guest, role: "operator" });
    const token = tokenOf(lastLink(guest));
    expect(await invitationByToken(token)).toMatchObject({
      email: guest,
      role: "operator",
      account: "none",
      inviterEmail: owner.email,
    });
    expect((await teamOverview(actor)).invitations).toHaveLength(1);

    await expect(
      acceptInvitation(token, { identity: null }),
    ).rejects.toMatchObject({ status: 400 });
    const joined = await acceptInvitation(token, {
      identity: null,
      password,
    });
    const created = await userByEmail(guest);
    expect(joined).toEqual({
      userId: created.id,
      organizationId: owner.organizationId,
    });
    expect(created.emailVerifiedAt).not.toBeNull();
    // No personal organization: the guest belongs to the inviting one only.
    const rows = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, created.id));
    expect(rows.map((r) => [r.organizationId, r.role])).toEqual([
      [owner.organizationId, "operator"],
    ]);
    await expect(
      acceptInvitation(token, { identity: null, password }),
    ).rejects.toMatchObject({ status: 410 });
    await expect(
      inviteMember(actor, { email: guest, role: "reviewer" }),
    ).rejects.toMatchObject({ status: 409 });
    const team = await teamOverview(actor);
    expect(team.members.map((m) => m.email).sort()).toEqual(
      [owner.email, guest].sort(),
    );
    expect(team.invitations).toHaveLength(0);
  });

  it("un compte existant confirme par mot de passe ou par sa session", async () => {
    const owner = await register("team-admin-2");
    await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.id, owner.userId));
    const actor = await identityOf(owner.userId, owner.organizationId);
    const other = await register("existing");

    await inviteMember(actor, { email: other.email, role: "reviewer" });
    const token = tokenOf(lastLink(other.email));
    expect(await invitationByToken(token)).toMatchObject({
      account: "password",
    });
    await expect(
      acceptInvitation(token, { identity: null, password: "mauvais secret!" }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      acceptInvitation(token, { identity: actor }),
    ).rejects.toMatchObject({ status: 403 });
    const signedIn = await identityOf(other.userId, other.organizationId);
    await expect(
      acceptInvitation(token, { identity: signedIn }),
    ).resolves.toEqual({
      userId: other.userId,
      organizationId: owner.organizationId,
    });
  });

  it("annule une invitation et gère les rôles des membres", async () => {
    const owner = await register("team-admin-3");
    await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.id, owner.userId));
    const actor = await identityOf(owner.userId, owner.organizationId);

    const cancelled = await inviteMember(actor, {
      email: address("cancelled"),
      role: "operator",
    });
    const cancelledToken = tokenOf(lastLink(address("cancelled")));
    await revokeInvitation(actor, cancelled.id);
    expect(await invitationByToken(cancelledToken)).toBeNull();
    await expect(revokeInvitation(actor, cancelled.id)).rejects.toMatchObject({
      status: 404,
    });

    const mate = address("mate");
    await inviteMember(actor, { email: mate, role: "reviewer" });
    const { userId } = await acceptInvitation(tokenOf(lastLink(mate)), {
      identity: null,
      password,
    });
    userIds.push(userId);
    await updateMemberRole(actor, userId, "admin");
    await expect(
      updateMemberRole(actor, owner.userId, "reviewer"),
    ).rejects.toMatchObject({ status: 400 });

    await openSession(userId, owner.organizationId);
    await removeMember(actor, userId);
    const [membership] = await db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.organizationId, owner.organizationId),
        ),
      );
    expect(membership.role).toBe("revoked");
    expect(
      await db.select().from(sessions).where(eq(sessions.userId, userId)),
    ).toHaveLength(0);
    await expect(removeMember(actor, userId)).rejects.toMatchObject({
      status: 404,
    });

    // A former member can be invited again and gets the new role back.
    await inviteMember(actor, { email: mate, role: "operator" });
    await acceptInvitation(tokenOf(lastLink(mate)), {
      identity: null,
      password,
    });
    const [back] = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.organizationId, owner.organizationId),
        ),
      );
    expect(back.role).toBe("operator");
  });

  it("les rôles gérés par le fournisseur d’identité restent en lecture seule", async () => {
    const owner = await register("team-admin-4");
    const sso = await register("sso-member");
    await db.insert(memberships).values({
      userId: sso.userId,
      organizationId: owner.organizationId,
      role: "operator",
      managedByOidc: true,
    });
    const actor = await identityOf(owner.userId, owner.organizationId);
    await expect(
      updateMemberRole(actor, sso.userId, "admin"),
    ).rejects.toMatchObject({ status: 409 });
    await expect(removeMember(actor, sso.userId)).rejects.toMatchObject({
      status: 409,
    });
  });
});
