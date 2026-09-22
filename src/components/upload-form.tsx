"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  FileSpreadsheet,
  FileUp,
  LoaderCircle,
  X,
} from "lucide-react";
const MAX_BYTES = 5 * 1024 * 1024;
export function UploadForm() {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  function choose(selected?: File) {
    if (!selected) return;
    setError("");
    if (!/\.(csv|xlsx)$/i.test(selected.name)) {
      setFile(null);
      setError("Choisissez un fichier CSV ou XLSX.");
      return;
    }
    if (!selected.size || selected.size > MAX_BYTES) {
      setFile(null);
      setError(
        "Le fichier doit contenir des données et peser au maximum 5 Mio.",
      );
      return;
    }
    setFile(selected);
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setPending(true);
    setError("");
    try {
      const initialization = await fetch("/api/uploads", { method: "POST" });
      let response: Response;
      if (initialization.ok) {
        const upload = await initialization.json();
        const transferred = await fetch(upload.url, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: file,
        });
        if (!transferred.ok)
          throw new Error(
            "Le stockage distant a refusé le transfert. Vérifiez la configuration CORS du bucket.",
          );
        response = await fetch("/api/imports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: upload.key, filename: file.name }),
        });
      } else if (initialization.status === 409)
        response = await fetch("/api/imports", {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-File-Name": encodeURIComponent(file.name),
          },
          body: file,
        });
      else {
        const data = await initialization.json();
        throw new Error(data.error);
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      router.push(`/imports/${data.id}`);
      router.refresh();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Import impossible. Vérifiez la connexion et réessayez.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={submit} className="upload-form">
      <div
        className={`dropzone ${dragging ? "dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          if (!pending) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!pending) choose(event.dataTransfer.files[0]);
        }}
      >
        <span className="upload-icon">
          <FileUp size={30} strokeWidth={1.5} />
        </span>
        <h2>Votre prochain catalogue commence ici.</h2>
        <p>
          Glissez votre fichier fournisseur ou sélectionnez-le sur votre
          appareil.
        </p>
        <input
          ref={input}
          className="sr-only"
          id="catalog-file"
          type="file"
          aria-label="Fichier catalogue fournisseur"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          disabled={pending}
          onChange={(event) => choose(event.target.files?.[0])}
        />
        <button
          type="button"
          className="button secondary"
          disabled={pending}
          onClick={() => input.current?.click()}
        >
          Choisir un fichier
        </button>
        <small>CSV ou XLSX · 5 Mio maximum · 50 000 lignes par feuille</small>
      </div>
      {file && (
        <div className="selected-file">
          <span className="file-icon">
            <FileSpreadsheet size={22} />
          </span>
          <div>
            <strong>{file.name}</strong>
            <small>
              {new Intl.NumberFormat("fr-FR", {
                maximumFractionDigits: 1,
              }).format(file.size / 1024)}{" "}
              Kio · Prêt à être analysé
            </small>
          </div>
          <button
            type="button"
            className="icon-button"
            disabled={pending}
            aria-label="Retirer le fichier"
            onClick={() => {
              setFile(null);
              if (input.current) input.current.value = "";
            }}
          >
            <X size={18} />
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="alert error">
          {error}
        </p>
      )}
      <div className="upload-form-footer">
        <p role="status">
          {pending
            ? "Transfert et analyse en cours. Cela peut prendre quelques instants."
            : "L’analyse ne modifie aucune donnée de votre fichier."}
        </p>
        <button className="button primary" disabled={!file || pending}>
          {pending ? (
            <LoaderCircle className="spin" size={18} />
          ) : (
            <ArrowRight size={18} />
          )}
          {pending ? "Analyse en cours…" : "Analyser le fichier"}
        </button>
      </div>
    </form>
  );
}
