import Link from "next/link";
import { Brand } from "@/components/brand";
import { AuthForm } from "@/components/auth-form";
export default function Login() {
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
