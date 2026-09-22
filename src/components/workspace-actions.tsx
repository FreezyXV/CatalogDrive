"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Trash2 } from "lucide-react";
export function LogoutButton() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <div>
      <button
        className="icon-button"
        aria-label="Se déconnecter"
        title="Se déconnecter"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError("");
          try {
            const response = await fetch("/api/auth/logout", {
              method: "POST",
            });
            if (!response.ok) throw new Error();
            router.push("/connexion");
            router.refresh();
          } catch {
            setError("Déconnexion impossible.");
          } finally {
            setPending(false);
          }
        }}
      >
        <LogOut size={18} />
      </button>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
export function DeleteImport({ id }: { id: string }) {
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  async function remove() {
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/imports/${id}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      router.push("/dashboard");
      router.refresh();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Suppression impossible.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="delete-area">
      {confirm ? (
        <div className="delete-confirm">
          <span>Supprimer définitivement cet import et son original ?</span>
          <button className="button danger" disabled={pending} onClick={remove}>
            {pending ? "Suppression…" : "Confirmer la suppression"}
          </button>
          <button
            className="button secondary"
            disabled={pending}
            onClick={() => setConfirm(false)}
          >
            Annuler
          </button>
        </div>
      ) : (
        <button
          className="text-button danger-text"
          onClick={() => setConfirm(true)}
        >
          <Trash2 size={15} />
          Supprimer cet import
        </button>
      )}
      {error && (
        <p role="alert" className="alert error">
          {error}
        </p>
      )}
    </div>
  );
}
