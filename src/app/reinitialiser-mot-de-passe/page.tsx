import Link from "next/link";
import { Brand } from "@/components/brand";
import { ResetPasswordForm } from "@/components/account-forms";

export default async function ResetPassword({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <main className="auth-page">
      <Link href="/">
        <Brand />
      </Link>
      <div className="auth-card">
        <span className="eyebrow">NOUVEAU MOT DE PASSE</span>
        <h1>
          Choisissez
          <br />
          votre clé.
        </h1>
        {token ? (
          <>
            <p>
              Le lien ne fonctionne qu’une fois et expire au bout d’1 heure.
            </p>
            <ResetPasswordForm token={token} />
          </>
        ) : (
          <div className="alert error" role="alert">
            Lien incomplet.{" "}
            <Link href="/mot-de-passe-oublie">Demandez un nouveau lien</Link>.
          </div>
        )}
      </div>
    </main>
  );
}
