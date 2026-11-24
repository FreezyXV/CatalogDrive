import { randomBytes } from "node:crypto";
import { and, asc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { db, type Transaction } from "@/server/db";
import {
  accountTokens,
  auditEvents,
  memberships,
  sessions,
  users,
} from "@/server/db/schema";
import { actionMail, appUrl, sendMail } from "@/server/mail";
import { HttpError } from "@/server/http";
import { hashPassword, hashToken } from "./password";

/**
 * Single-use account links (email verification, password reset), stored in
 * `account_tokens` as SHA-256 hashes. Issuing a new link for a purpose
 * invalidates the previous one; consuming deletes it atomically.
 */
export const TOKEN_MINUTES = {
  email_verification: 24 * 60,
  password_reset: 60,
} as const;
export type TokenPurpose = keyof typeof TOKEN_MINUTES;

export const newSecret = () => randomBytes(32).toString("base64url");

type Executor = typeof db | Transaction;

export async function issueAccountToken(
  executor: Executor,
  userId: string,
  purpose: TokenPurpose,
) {
  const token = newSecret();
  await executor
    .delete(accountTokens)
    .where(
      and(eq(accountTokens.userId, userId), eq(accountTokens.purpose, purpose)),
    );
  await executor.insert(accountTokens).values({
    tokenHash: hashToken(token),
    userId,
    purpose,
    expiresAt: new Date(Date.now() + TOKEN_MINUTES[purpose] * 60_000),
  });
  return token;
}

export async function consumeAccountToken(
  executor: Executor,
  token: string,
  purpose: TokenPurpose,
) {
  const [row] = await executor
    .delete(accountTokens)
    .where(
      and(
        eq(accountTokens.tokenHash, hashToken(token)),
        eq(accountTokens.purpose, purpose),
        gt(accountTokens.expiresAt, new Date()),
      ),
    )
    .returning({ userId: accountTokens.userId });
  return row?.userId ?? null;
}

/** Audit events belong to a membership: record on the user's first active one. */
async function auditForUser(tx: Transaction, userId: string, action: string) {
  const [membership] = await tx
    .select({ organizationId: memberships.organizationId })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), ne(memberships.role, "revoked")))
    .orderBy(asc(memberships.organizationId))
    .limit(1);
  if (membership)
    await tx.insert(auditEvents).values({
      userId,
      organizationId: membership.organizationId,
      action,
      entityId: userId,
    });
}

/** Sends a verification link to a local account whose email is unverified. */
export async function sendEmailVerification(userId: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user || user.emailVerifiedAt || user.oidcSubject) return false;
  const token = await issueAccountToken(db, user.id, "email_verification");
  await sendMail(
    actionMail({
      to: user.email,
      subject: "Confirmez votre adresse email CataMotive",
      intro: [
        "Bonjour,",
        "Confirmez votre adresse email pour sécuriser votre espace CataMotive et pouvoir inviter votre équipe.",
      ],
      action: "Confirmer mon adresse",
      url: appUrl(`/verifier-email?token=${encodeURIComponent(token)}`),
      outro:
        "Ce lien expire dans 24 heures. Si vous n’avez pas créé de compte, ignorez cet email.",
    }),
  );
  return true;
}

export async function verifyEmail(token: string) {
  return db.transaction(async (tx) => {
    const userId = await consumeAccountToken(tx, token, "email_verification");
    if (!userId) return false;
    await tx
      .update(users)
      .set({ emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
      .where(eq(users.id, userId));
    await auditForUser(tx, userId, "user.email_verified");
    return true;
  });
}

/**
 * Always resolves the same way, whether or not the address has an account,
 * so the form cannot be used to discover registered emails. SSO accounts
 * manage their password at their identity provider and get no link.
 */
export async function requestPasswordReset(email: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email), isNull(users.oidcSubject)))
    .limit(1);
  if (!user) return;
  const token = await issueAccountToken(db, user.id, "password_reset");
  // A delivery failure must not reveal that the account exists.
  await sendMail(
    actionMail({
      to: user.email,
      subject: "Réinitialisez votre mot de passe CataMotive",
      intro: [
        "Bonjour,",
        "Une réinitialisation du mot de passe a été demandée pour votre compte CataMotive.",
      ],
      action: "Choisir un nouveau mot de passe",
      url: appUrl(
        `/reinitialiser-mot-de-passe?token=${encodeURIComponent(token)}`,
      ),
      outro:
        "Ce lien expire dans 1 heure et ne fonctionne qu’une fois. Si vous n’êtes pas à l’origine de cette demande, ignorez cet email : votre mot de passe reste inchangé.",
    }),
  ).catch((error: unknown) =>
    console.error(
      "Email de réinitialisation non envoyé",
      error instanceof Error ? error.name : "UnknownError",
    ),
  );
}

/**
 * Sets the new password, closes every open session of the account and marks
 * the email as verified (the person proved they read the inbox).
 */
export async function resetPassword(token: string, password: string) {
  const passwordHash = await hashPassword(password);
  await db.transaction(async (tx) => {
    const userId = await consumeAccountToken(tx, token, "password_reset");
    if (!userId)
      throw new HttpError(
        400,
        "Ce lien est invalide ou a expiré. Demandez un nouveau lien.",
      );
    const [updated] = await tx
      .update(users)
      .set({
        passwordHash,
        emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())`,
      })
      .where(and(eq(users.id, userId), isNull(users.oidcSubject)))
      .returning({ id: users.id });
    if (!updated)
      throw new HttpError(
        400,
        "Ce lien est invalide ou a expiré. Demandez un nouveau lien.",
      );
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await auditForUser(tx, userId, "user.password_reset");
  });
}
