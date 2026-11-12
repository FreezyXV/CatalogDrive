import Link from "next/link";
import { KeyRound } from "lucide-react";
import { Brand } from "@/components/brand";
import { AuthForm } from "@/components/auth-form";
import { oidcConfig } from "@/server/auth/oidc";
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ sso_error?: string }>;
}) {
  const { sso_error: ssoError } = await searchParams;
  const sso = oidcConfig() !== null;
  return (
    <main className="auth-page">
      <Link href="/">
        <Brand />
      </Link>
      <div className="auth-card">
        <span className="eyebrow">VOTRE ESPACE CATALOGUE</span>
        <h1>
          De retour
          <br />à l’atelier.
        </h1>
        <p>Connectez-vous pour retrouver vos imports.</p>
        {sso ? (
          <>
            {/* A full page navigation is required: the route handler redirects
                to the identity provider (another origin). <Link> would try a
                client-side transition and prefetch it. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a className="button primary full" href="/api/auth/oidc/login">
              <KeyRound size={17} />
              Se connecter avec le SSO de l’entreprise
            </a>
            {ssoError ? (
              <p role="alert" className="form-error">
                {ssoError.slice(0, 200)}
              </p>
            ) : null}
            <p className="fine-print">
              Authentification à deux facteurs exigée par le fournisseur
              d’identité.
            </p>
          </>
        ) : null}
        <AuthForm />
        <p className="auth-switch">
          Première visite ? <Link href="/inscription">Créer mon espace</Link>
        </p>
      </div>
      <span className="fine-print">
        Récupération de mot de passe indisponible dans ce pilote local.
      </span>
    </main>
  );
}
