import Link from "next/link";
import { Brand } from "@/components/brand";
import { AuthForm } from "@/components/auth-form";
export default function Register() {
  return (
    <main className="auth-page">
      <Link href="/">
        <Brand />
      </Link>
      <div className="auth-card">
        <span className="eyebrow">BIENVENUE DANS VOTRE ATELIER</span>
        <h1>
          Un espace pour
          <br />
          vos catalogues.
        </h1>
        <p>Créez votre compte et votre organisation.</p>
        <AuthForm register />
        <p className="auth-switch">
          Déjà un compte ? <Link href="/connexion">Se connecter</Link>
        </p>
      </div>
      <span className="fine-print">CataMotive · Pilote local, jalon 1</span>
    </main>
  );
}
