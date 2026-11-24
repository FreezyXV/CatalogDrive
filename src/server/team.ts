import { and, asc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { db, lockTransaction, type Transaction } from "./db";
import {
  auditEvents,
  invitations,
  memberships,
  organizations,
  sessions,
  users,
} from "./db/schema";
import { HttpError } from "./http";
import { limitOrganizationAction } from "./limits";
import { actionMail, appUrl, sendMail } from "./mail";
import type { Identity } from "./auth";
import { newSecret } from "./auth/account";
import { hashPassword, hashToken, verifyPassword } from "./auth/password";
import { normalizeRole, ROLE_LABELS, type Role } from "./auth/rbac";

/**
 * Team management: members of the actor's organization, invitations by
 * email, role changes and removal. Memberships granted by the identity
 * provider (managedByOidc) stay read-only here: the IdP is their source of
 * truth and would overwrite any local change at the next login.
 */
export const INVITATION_DAYS = 7;

export async function teamOverview(actor: Identity) {
  const members = await db
    .select({
      userId: users.id,
      email: users.email,
      role: memberships.role,
      managedByOidc: memberships.managedByOidc,
      emailVerified: sql<boolean>`${users.emailVerifiedAt} is not null`,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(
      and(
        eq(memberships.organizationId, actor.organizationId),
        ne(memberships.role, "revoked"),
      ),
    )
    .orderBy(asc(users.email));
  const pending = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      expiresAt: invitations.expiresAt,
    })
    .from(invitations)
    .where(
      and(
        eq(invitations.organizationId, actor.organizationId),
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .orderBy(asc(invitations.email));
  return {
    members: members.map((m) => ({ ...m, role: normalizeRole(m.role) })),
    invitations: pending.map((i) => ({ ...i, role: normalizeRole(i.role) })),
  };
}

export async function inviteMember(
  actor: Identity,
  input: { email: string; role: Role },
) {
  // Invitation emails go to third parties: only proven addresses may send them.
  if (!actor.emailVerified)
    throw new HttpError(
      403,
      "Confirmez d’abord votre adresse email pour inviter votre équipe.",
    );
  if (input.email === actor.email)
    throw new HttpError(400, "Vous faites déjà partie de cette organisation.");
  await limitOrganizationAction(actor.organizationId, "invite");
  const token = newSecret();
  const invitation = await db.transaction(async (tx) => {
    const [member] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(
        and(
          eq(memberships.organizationId, actor.organizationId),
          eq(users.email, input.email),
          ne(memberships.role, "revoked"),
        ),
      )
      .limit(1);
    if (member)
      throw new HttpError(409, "Cette personne fait déjà partie de l’équipe.");
    const values = {
      role: input.role,
      tokenHash: hashToken(token),
      invitedBy: actor.userId,
      expiresAt: new Date(Date.now() + INVITATION_DAYS * 24 * 60 * 60_000),
      acceptedAt: null,
      createdAt: new Date(),
    };
    const [row] = await tx
      .insert(invitations)
      .values({
        ...values,
        organizationId: actor.organizationId,
        email: input.email,
      })
      .onConflictDoUpdate({
        target: [invitations.organizationId, invitations.email],
        set: values,
      })
      .returning();
    await tx.insert(auditEvents).values({
      userId: actor.userId,
      organizationId: actor.organizationId,
      action: "invitation.sent",
      entityId: row.id,
    });
    return row;
  });
  await sendMail(
    actionMail({
      to: input.email,
      subject: `${actor.organizationName} vous invite sur CataMotive`,
      intro: [
        "Bonjour,",
        `${actor.email} vous invite à rejoindre l’organisation « ${actor.organizationName} » sur CataMotive, avec le rôle ${ROLE_LABELS[input.role]}.`,
        "CataMotive transforme les catalogues fournisseurs en données propres, contrôlées et prêtes à importer.",
      ],
      action: "Rejoindre l’équipe",
      url: appUrl(`/invitation/${encodeURIComponent(token)}`),
      outro: `Cette invitation expire dans ${INVITATION_DAYS} jours. Si vous ne connaissez pas l’expéditeur, ignorez cet email.`,
    }),
  );
  return {
    id: invitation.id,
    email: invitation.email,
    role: input.role,
    expiresAt: invitation.expiresAt,
  };
}

export async function revokeInvitation(actor: Identity, id: string) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(invitations)
      .where(
        and(
          eq(invitations.id, id),
          eq(invitations.organizationId, actor.organizationId),
          isNull(invitations.acceptedAt),
        ),
      )
      .returning({ id: invitations.id });
    if (!row) throw new HttpError(404, "Invitation introuvable.");
    await tx.insert(auditEvents).values({
      userId: actor.userId,
      organizationId: actor.organizationId,
      action: "invitation.revoked",
      entityId: row.id,
    });
  });
}

/** Public details of a pending invitation, for its landing page. */
export async function invitationByToken(token: string) {
  const [row] = await db
    .select({
      email: invitations.email,
      role: invitations.role,
      organizationName: organizations.name,
      inviterEmail: users.email,
      expiresAt: invitations.expiresAt,
    })
    .from(invitations)
    .innerJoin(organizations, eq(invitations.organizationId, organizations.id))
    .innerJoin(users, eq(invitations.invitedBy, users.id))
    .where(
      and(
        eq(invitations.tokenHash, hashToken(token)),
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) return null;
  const [account] = await db
    .select({ oidcSubject: users.oidcSubject })
    .from(users)
    .where(eq(users.email, row.email))
    .limit(1);
  return {
    ...row,
    role: normalizeRole(row.role),
    account: !account ? "none" : account.oidcSubject ? "sso" : "password",
  } as const;
}

/**
 * Accepts an invitation and returns the identity to open a session for.
 * - signed in with the invited address: joins directly;
 * - existing password account: the password confirms the person;
 * - no account yet: creates one with the given password. The invitation link
 *   proves the inbox, so the address is verified and no personal space is made.
 */
export async function acceptInvitation(
  token: string,
  options: { identity: Identity | null; password?: string },
) {
  const invalid = () =>
    new HttpError(
      410,
      "Cette invitation est invalide, a expiré ou a déjà été utilisée.",
    );
  const [found] = await db
    .select()
    .from(invitations)
    .where(eq(invitations.tokenHash, hashToken(token)))
    .limit(1);
  if (!found || found.acceptedAt || found.expiresAt <= new Date())
    throw invalid();
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.email, found.email))
    .limit(1);
  if (options.identity) {
    if (options.identity.email !== found.email)
      throw new HttpError(
        403,
        `Cette invitation est destinée à ${found.email}. Déconnectez-vous puis rouvrez le lien.`,
      );
  } else if (existing) {
    if (existing.oidcSubject)
      throw new HttpError(
        409,
        "Ce compte utilise Google ou le SSO. Connectez-vous avec votre méthode habituelle, puis rouvrez ce lien.",
      );
    if (
      !options.password ||
      !(await verifyPassword(options.password, existing.passwordHash))
    )
      throw new HttpError(401, "Mot de passe incorrect.");
  } else if (!options.password) {
    throw new HttpError(
      400,
      "Choisissez un mot de passe pour créer votre compte.",
    );
  }
  const newPasswordHash =
    !existing && options.password ? await hashPassword(options.password) : null;

  return db.transaction(async (tx) => {
    await lockTransaction(tx, `invitation:${found.id}`);
    const [invitation] = await tx
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.id, found.id),
          eq(invitations.tokenHash, found.tokenHash),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!invitation) throw invalid();
    let userId = existing?.id;
    if (!userId) {
      const [created] = await tx
        .insert(users)
        .values({
          email: invitation.email,
          passwordHash: newPasswordHash!,
          emailVerifiedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: users.id });
      if (!created)
        throw new HttpError(409, "Un compte existe déjà. Rouvrez le lien.");
      userId = created.id;
    } else {
      await tx
        .update(users)
        .set({
          emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())`,
        })
        .where(eq(users.id, userId));
    }
    // A former member gets the invited role back; an active one keeps theirs.
    await tx
      .insert(memberships)
      .values({
        userId,
        organizationId: invitation.organizationId,
        role: normalizeRole(invitation.role),
        managedByOidc: false,
      })
      .onConflictDoUpdate({
        target: [memberships.userId, memberships.organizationId],
        set: { role: normalizeRole(invitation.role), managedByOidc: false },
        setWhere: eq(memberships.role, "revoked"),
      });
    await tx
      .update(invitations)
      .set({ acceptedAt: new Date() })
      .where(eq(invitations.id, invitation.id));
    await tx.insert(auditEvents).values({
      userId,
      organizationId: invitation.organizationId,
      action: "invitation.accepted",
      entityId: invitation.id,
    });
    return { userId, organizationId: invitation.organizationId };
  });
}

async function editableMember(
  actor: Identity,
  userId: string,
  tx: Transaction,
) {
  if (userId === actor.userId)
    throw new HttpError(
      400,
      "Vous ne pouvez pas modifier votre propre accès. Demandez à un autre administrateur.",
    );
  // Serialise admin changes so two admins cannot remove each other at once.
  await lockTransaction(tx, `members:${actor.organizationId}`);
  const [member] = await tx
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, actor.organizationId),
        eq(memberships.userId, userId),
        ne(memberships.role, "revoked"),
      ),
    )
    .limit(1);
  if (!member) throw new HttpError(404, "Membre introuvable.");
  if (member.managedByOidc)
    throw new HttpError(
      409,
      "Ce rôle est géré par votre fournisseur d’identité. Modifiez-le là-bas.",
    );
  return member;
}

export async function updateMemberRole(
  actor: Identity,
  userId: string,
  role: Role,
) {
  await db.transaction(async (tx) => {
    await editableMember(actor, userId, tx);
    await tx
      .update(memberships)
      .set({ role })
      .where(
        and(
          eq(memberships.organizationId, actor.organizationId),
          eq(memberships.userId, userId),
        ),
      );
    await tx.insert(auditEvents).values({
      userId: actor.userId,
      organizationId: actor.organizationId,
      action: "membership.role_changed",
      entityId: userId,
    });
  });
}

/** Revokes access (history keeps the membership) and closes the member's sessions. */
export async function removeMember(actor: Identity, userId: string) {
  await db.transaction(async (tx) => {
    await editableMember(actor, userId, tx);
    await tx
      .update(memberships)
      .set({ role: "revoked" })
      .where(
        and(
          eq(memberships.organizationId, actor.organizationId),
          eq(memberships.userId, userId),
        ),
      );
    await tx
      .delete(sessions)
      .where(
        and(
          eq(sessions.organizationId, actor.organizationId),
          eq(sessions.userId, userId),
        ),
      );
    await tx.insert(auditEvents).values({
      userId: actor.userId,
      organizationId: actor.organizationId,
      action: "membership.revoked",
      entityId: userId,
    });
  });
}
