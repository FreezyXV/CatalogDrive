import Link from "next/link";
import { Brand } from "@/components/brand";
import { InvitationAcceptForm } from "@/components/account-forms";
import { currentIdentity } from "@/server/auth";
import { ROLE_LABELS } from "@/server/auth/rbac";
import { tokenSchema } from "@/server/auth/schemas";
import { invitationByToken } from "@/server/team";

export const dynamic = "force-dynamic";

export default async function Invitation({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const parsed = tokenSchema.safeParse((await params).token);
  const invitation = parsed.success
    ? await invitationByToken(parsed.data)
    : null;
  const identity = await currentIdentity();
  return (
    <main className="auth-page">
      <Link href="/">
        <Brand />
      </Link>
      <div className="auth-card">
        <span className="eyebrow">INVITATION</span>
        {!invitation || !parsed.success ? (
          <>
            <h1>Invitation expirée.</h1>
            <div className="alert error" role="alert">
              Cette invitation est invalide, a expiré ou a déjà été utilisée.
              Demandez une nouvelle invitation à votre administrateur.
            </div>
          </>
        ) : (
          <>
            <h1>
              Rejoignez
              <br />
              {invitation.organizationName}.
            </h1>
            <p>
              {invitation.inviterEmail} vous invite avec le rôle{" "}
              <strong>{ROLE_LABELS[invitation.role]}</strong>. Invitation
              destinée à <strong>{invitation.email}</strong>.
            </p>
            {identity ? (
              identity.email === invitation.email ? (
                <InvitationAcceptForm token={parsed.data} mode="signed-in" />
              ) : (
                <div className="alert error" role="alert">
                  Vous êtes connecté avec {identity.email}. Déconnectez-vous,
                  puis rouvrez ce lien.
                </div>
              )
            ) : invitation.account === "sso" ? (
              <div className="alert warning" role="status">
                Ce compte utilise Google ou le SSO.{" "}
                <Link href="/connexion">Connectez-vous</Link>, puis rouvrez ce
                lien.
              </div>
            ) : (
              <InvitationAcceptForm
                token={parsed.data}
                mode={invitation.account === "password" ? "login" : "create"}
              />
            )}
          </>
        )}
      </div>
      <span className="fine-print">
        CataMotive · Catalogues fournisseurs fiables
      </span>
    </main>
  );
}
