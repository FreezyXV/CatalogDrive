import Link from "next/link";
import { Brand } from "@/components/brand";
import { verifyEmail } from "@/server/auth/account";
import { tokenSchema } from "@/server/auth/schemas";

export const dynamic = "force-dynamic";

export default async function VerifyEmail({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const parsed = tokenSchema.safeParse((await searchParams).token);
  const verified = parsed.success && (await verifyEmail(parsed.data));
  return (
    <main className="auth-page">
      <Link href="/">
        <Brand />
      </Link>
      <div className="auth-card">
        <span className="eyebrow">CONFIRMATION D’ADRESSE</span>
        <h1>{verified ? "Adresse confirmée." : "Lien expiré."}</h1>
        <div
          className={`alert ${verified ? "success" : "error"}`}
          role={verified ? "status" : "alert"}
        >
          {verified
            ? "Merci ! Votre adresse email est confirmée. Vous pouvez maintenant inviter votre équipe."
            : "Ce lien est invalide, a expiré ou a déjà été utilisé. Depuis votre espace, demandez un nouveau lien."}
        </div>
        <Link className="button primary full" href="/dashboard">
          Ouvrir mon espace
        </Link>
      </div>
    </main>
  );
}
