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

async function multipartCommand(
  body: Record<string, unknown>,
  allowUnavailable = false,
) {
  const response = await fetch("/api/uploads/multipart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok && (!allowUnavailable || response.status !== 409))
    throw new Error(data.error ?? "Transfert impossible.");
  return { response, data };
}

export async function transferInParts(
  file: File,
  onProgress: (percent: number) => void,
) {
  const started = await multipartCommand(
    { action: "start", bytes: file.size },
    true,
  );
  if (started.response.status === 409) return null;
  const { token, partBytes } = started.data as {
    token: string;
    partBytes: number;
  };
  try {
    if (!Number.isSafeInteger(partBytes) || partBytes <= 0)
      throw new Error("Taille des parties de transfert invalide.");
    const partCount = Math.ceil(file.size / partBytes);
    let nextPart = 1;
    let completedBytes = 0;
    let stopped = false;
    const uploadPart = async (number: number) => {
      const start = (number - 1) * partBytes;
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const signed = await multipartCommand({
            action: "part",
            token,
            number,
          });
          const transferred = await fetch(signed.data.url, {
            method: "PUT",
            body: file.slice(start, start + partBytes),
          });
          if (!transferred.ok)
            throw new Error(`Partie ${number} refusée par le stockage.`);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 2)
            await new Promise((resolve) =>
              setTimeout(resolve, 500 * (attempt + 1)),
            );
        }
      }
      if (lastError) throw lastError;
      completedBytes += Math.min(partBytes, file.size - start);
      onProgress(Math.floor((completedBytes / file.size) * 100));
    };
    const workers = Array.from({ length: Math.min(4, partCount) }, async () => {
      while (!stopped) {
        const number = nextPart++;
        if (number > partCount) return;
        try {
          await uploadPart(number);
        } catch (error) {
          stopped = true;
          throw error;
        }
      }
    });
    const results = await Promise.allSettled(workers);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    const completed = await multipartCommand({ action: "complete", token });
    return completed.data.key as string;
  } catch (error) {
    await multipartCommand({ action: "abort", token }).catch(() => undefined);
    throw error;
  }
}

export function UploadForm({
  maxBytes,
  maxLabel,
}: {
  maxBytes: number;
  maxLabel: string;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  function choose(selected?: File) {
    if (!selected) return;
    setError("");
    if (!/\.(csv|xlsx|zip)$/i.test(selected.name)) {
      setFile(null);
      setError("Choisissez un fichier CSV, XLSX ou ZIP.");
      return;
    }
    if (!selected.size || selected.size > maxBytes) {
      setFile(null);
      setError(
        `Le fichier doit contenir des données et peser au maximum ${maxLabel}.`,
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
    setProgress(null);
    try {
      let response: Response;
      const multipartKey =
        file.size > 5 * 1024 * 1024
          ? await transferInParts(file, setProgress)
          : null;
      if (!multipartKey) setProgress(null);
      if (multipartKey) {
        response = await fetch("/api/imports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: multipartKey, filename: file.name }),
        });
      } else {
        const initialization = await fetch("/api/uploads", { method: "POST" });
        if (initialization.ok) {
          const upload = await initialization.json();
          const transferred = await fetch(upload.url, {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream" },
            body: file,
          });
          if (!transferred.ok)
            throw new Error("Le stockage distant a refusé le transfert.");
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
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      router.push(data.count > 1 ? "/dashboard" : `/imports/${data.id}`);
      router.refresh();
    } catch (error) {
      setProgress(null);
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
          accept=".csv,.xlsx,.zip,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/zip"
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
        <small>
          CSV, XLSX ou ZIP de plusieurs catalogues · {maxLabel} maximum par
          fichier déposé
        </small>
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
      {progress !== null && (
        <progress
          className="upload-progress"
          max={100}
          value={progress}
          aria-label="Progression du transfert"
        />
      )}
      <div className="upload-form-footer">
        <p role="status">
          {pending
            ? progress === null
              ? "Transfert et analyse en cours. Cela peut prendre quelques instants."
              : progress < 100
                ? `Transfert du fichier : ${progress} %. Gardez cette page ouverte.`
                : "Transfert terminé. Analyse du fichier en cours."
            : "L’analyse ne modifie aucune donnée de votre fichier."}
        </p>
        <button className="button primary" disabled={!file || pending}>
          {pending ? (
            <LoaderCircle className="spin" size={18} />
          ) : (
            <ArrowRight size={18} />
          )}
          {pending
            ? progress !== null && progress < 100
              ? "Transfert en cours…"
              : "Analyse en cours…"
            : "Analyser le fichier"}
        </button>
      </div>
    </form>
  );
}
