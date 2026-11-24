import Link from "next/link";
import { Brand } from "@/components/brand";
import { AuthForm } from "@/components/auth-form";
import { SsoButtons } from "@/components/sso-buttons";
import { oidcConfig } from "@/server/auth/oidc";
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ sso_error?: string }>;
}) {
  const { sso_error: ssoError } = await searchParams;
  const sso = oidcConfig();
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
          <SsoButtons connections={sso.connections} error={ssoError} />
        ) : null}
        <AuthForm />
        <p className="auth-links">
          <Link href="/mot-de-passe-oublie">Mot de passe oublié ?</Link>
        </p>
        <p className="auth-switch">
          Première visite ? <Link href="/inscription">Créer mon espace</Link>
        </p>
      </div>
      <span className="fine-print">
        Vous utilisez Google ou le SSO ? Gérez votre mot de passe auprès de
        votre fournisseur de connexion.
      </span>
    </main>
  );
}
