"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="error-page">
      <h1>Une erreur est survenue.</h1>
      <p>Vérifiez que la base PostgreSQL est disponible, puis réessayez.</p>
      <button className="button primary" onClick={reset}>
        Réessayer
      </button>
    </main>
  );
}
