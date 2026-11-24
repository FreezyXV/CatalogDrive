"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, LoaderCircle, MailCheck } from "lucide-react";

export async function sendJson(
  url: string,
  body?: unknown,
  method: "POST" | "PATCH" | "DELETE" = "POST",
) {
  const response = await fetch(url, {
    method,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Une erreur est survenue.");
  return data;
}

function useSubmit() {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function run(action: () => Promise<void>) {
    setError("");
    setPending(true);
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Une erreur est survenue.",
      );
    } finally {
      setPending(false);
    }
  }
  return { error, pending, run };
}

function SubmitButton({ pending, label }: { pending: boolean; label: string }) {
  return (
    <button className="button primary full" disabled={pending}>
      {pending ? (
        <LoaderCircle className="spin" size={18} />
      ) : (
        <ArrowRight size={18} />
      )}
      {pending ? "Veuillez patienter…" : label}
    </button>
  );
}

function ErrorAlert({ error }: { error: string }) {
  return error ? (
    <div role="alert" className="alert error">
      {error}
    </div>
  ) : null;
}

function PasswordField({ label = "Mot de passe", isNew = true }) {
  return (
    <label>
      {label}
      <input
        type="password"
        name="password"
        autoComplete={isNew ? "new-password" : "current-password"}
        minLength={12}
        maxLength={128}
        required
      />
      {isNew && <small>12 caractères minimum.</small>}
    </label>
  );
}

export function ForgotPasswordForm() {
  const { error, pending, run } = useSubmit();
  const [sent, setSent] = useState(false);
  if (sent)
    return (
      <div className="alert success" role="status">
        Si un compte existe pour cette adresse, un lien de réinitialisation
        vient d’être envoyé. Il expire dans 1 heure.
      </div>
    );
  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        const email = new FormData(event.currentTarget).get("email");
        void run(async () => {
          await sendJson("/api/auth/password/forgot", { email });
          setSent(true);
        });
      }}
    >
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
      <ErrorAlert error={error} />
      <SubmitButton pending={pending} label="Recevoir un lien" />
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const { error, pending, run } = useSubmit();
  const [done, setDone] = useState(false);
  if (done)
    return (
      <div className="form-stack">
        <div className="alert success" role="status">
          Mot de passe modifié. Toutes vos sessions ouvertes ont été fermées.
        </div>
        <Link className="button primary full" href="/connexion">
          Me connecter
        </Link>
      </div>
    );
  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const password = String(data.get("password"));
        void run(async () => {
          if (password !== data.get("confirmation"))
            throw new Error("Les deux mots de passe ne correspondent pas.");
          await sendJson("/api/auth/password/reset", { token, password });
          setDone(true);
        });
      }}
    >
      <PasswordField label="Nouveau mot de passe" />
      <label>
        Confirmation
        <input
          type="password"
          name="confirmation"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
      </label>
      <ErrorAlert error={error} />
      <SubmitButton pending={pending} label="Enregistrer le mot de passe" />
    </form>
  );
}

export function InvitationAcceptForm({
  token,
  mode,
}: {
  token: string;
  /** signed-in: joins directly; login: existing password; create: new account. */
  mode: "signed-in" | "login" | "create";
}) {
  const router = useRouter();
  const { error, pending, run } = useSubmit();
  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        const password = new FormData(event.currentTarget).get("password");
        void run(async () => {
          await sendJson("/api/invitations/accept", {
            token,
            ...(mode === "signed-in" ? {} : { password }),
          });
          router.push("/dashboard");
          router.refresh();
        });
      }}
    >
      {mode === "create" && (
        <PasswordField label="Choisissez votre mot de passe" />
      )}
      {mode === "login" && (
        <PasswordField label="Votre mot de passe" isNew={false} />
      )}
      <ErrorAlert error={error} />
      <SubmitButton
        pending={pending}
        label={
          mode === "create"
            ? "Créer mon compte et rejoindre"
            : "Rejoindre l’équipe"
        }
      />
      {mode === "login" && (
        <p className="fine-print">
          Mot de passe oublié ?{" "}
          <Link href="/mot-de-passe-oublie">Recevoir un lien</Link>, puis
          rouvrez cette invitation.
        </p>
      )}
    </form>
  );
}

export function VerifyEmailBanner() {
  const { error, pending, run } = useSubmit();
  const [sent, setSent] = useState(false);
  return (
    <div className="alert warning verify-banner" role="status">
      <MailCheck size={17} />
      <span>
        {sent
          ? "Lien envoyé. Consultez votre boîte de réception."
          : error ||
            "Confirmez votre adresse email pour sécuriser votre compte et inviter votre équipe."}
      </span>
      {!sent && (
        <button
          className="button secondary"
          disabled={pending}
          onClick={() =>
            void run(async () => {
              await sendJson("/api/auth/email/resend");
              setSent(true);
            })
          }
        >
          {pending ? "Envoi…" : "Renvoyer le lien"}
        </button>
      )}
    </div>
  );
}
