"use client";
import { useState } from "react";
import { Save } from "lucide-react";
export function OrganizationForm({
  name: initialName,
  retention: initialRetention,
}: {
  name: string;
  retention: number;
}) {
  const [name, setName] = useState(initialName);
  const [retentionDays, setRetention] = useState(initialRetention);
  const [state, setState] = useState<"" | "pending" | "saved">("");
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setState("pending");
    setError("");
    const response = await fetch("/api/organization", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, retentionDays }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error);
      setState("");
      return;
    }
    setState("saved");
  }
  return (
    <form className="panel form-panel" onSubmit={submit}>
      <div className="panel-heading">
        <div>
          <h2>Organisation</h2>
          <p>Ces réglages s’appliquent à l’ensemble de votre espace privé.</p>
        </div>
      </div>
      <div className="settings-grid">
        <label>
          Nom de l’organisation
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
          />
        </label>
        <label>
          Conservation des fichiers
          <select
            value={retentionDays}
            onChange={(event) => setRetention(Number(event.target.value))}
          >
            {[7, 14, 30, 60, 90, 180, 365].map((days) => (
              <option value={days} key={days}>
                {days} jours
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-section export-footer">
        <span className="fine-print">
          La purge automatique est exécutée quotidiennement en production.
        </span>
        <button className="button primary" disabled={state === "pending"}>
          <Save size={16} />
          {state === "pending"
            ? "Enregistrement…"
            : state === "saved"
              ? "Enregistré"
              : "Enregistrer"}
        </button>
      </div>
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
