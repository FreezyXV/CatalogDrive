import Link from "next/link";
import { Brand } from "@/components/brand";
import { ForgotPasswordForm } from "@/components/account-forms";

export default function ForgotPassword() {
  return (
    <main className="auth-page">
      <Link href="/">
        <Brand />
      </Link>
      <div className="auth-card">
        <span className="eyebrow">MOT DE PASSE OUBLIÉ</span>
        <h1>
          Un nouveau
          <br />
          départ.
        </h1>
        <p>
          Indiquez votre adresse : vous recevrez un lien pour choisir un nouveau
          mot de passe.
        </p>
        <ForgotPasswordForm />
        <p className="auth-switch">
          Mot de passe retrouvé ? <Link href="/connexion">Se connecter</Link>
        </p>
      </div>
      <span className="fine-print">
        Vous utilisez Google ou le SSO ? Gérez votre mot de passe auprès de
        votre fournisseur de connexion.
      </span>
    </main>
  );
}
