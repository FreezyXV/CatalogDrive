"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, LoaderCircle } from "lucide-react";
export function AuthForm({ register = false }: { register?: boolean }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPending(true);
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const response = await fetch(
        `/api/auth/${register ? "register" : "login"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      router.push("/dashboard");
      router.refresh();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Connexion impossible.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={submit} className="form-stack">
      {register && (
        <label>
          Nom de l’organisation
          <input
            name="organizationName"
            autoComplete="organization"
            placeholder="Ex. Atelier Martin"
            minLength={2}
            maxLength={80}
            required
          />
        </label>
      )}
      <label>
        Adresse email
        <input
          type="email"
          name="email"
          autoComplete="email"
          placeholder="vous@entreprise.fr"
          maxLength={254}
          required
        />
      </label>
      <label>
        Mot de passe
        <input
          type="password"
          name="password"
          autoComplete={register ? "new-password" : "current-password"}
          minLength={12}
          maxLength={128}
          required
        />
        {register && <small>12 caractères minimum.</small>}
      </label>
      {error && (
        <div role="alert" className="alert error">
          {error}
        </div>
      )}
      <button className="button primary full" disabled={pending}>
        {pending ? (
          <LoaderCircle className="spin" size={18} />
        ) : (
          <ArrowRight size={18} />
        )}
        {pending
          ? "Veuillez patienter…"
          : register
            ? "Créer mon espace"
            : "Me connecter"}
      </button>
      {register && (
        <p className="fine-print">
          Pilote local gratuit. Aucun paiement ni email de vérification n’est
          envoyé.
        </p>
      )}
    </form>
  );
}
