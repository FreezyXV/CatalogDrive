import Link from "next/link";
export default function NotFound() {
  return (
    <main className="error-page">
      <span className="eyebrow">404</span>
      <h1>Page introuvable.</h1>
      <p>
        Ce contenu n’existe pas ou n’est pas accessible dans votre organisation.
      </p>
      <Link href="/dashboard" className="button primary">
        Revenir à mon espace
      </Link>
    </main>
  );
}
