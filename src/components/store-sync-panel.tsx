"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FlaskConical, LoaderCircle, RotateCcw, Send } from "lucide-react";
import {
  STORE_PLATFORMS,
  SYNC_UPDATE_MODES,
  type SyncOptions,
} from "@/domain/store-sync";
import type { PublicConnection } from "@/server/stores/connections";
import type { PublicSync } from "@/server/stores/sync";

const STATUS: Record<PublicSync["status"], string> = {
  queued: "En attente",
  running: "En cours",
  done: "Terminé",
  failed: "Échec",
};
const active = (sync: PublicSync) =>
  sync.status === "queued" || sync.status === "running";

export function StoreSyncPanel({
  importId,
  connections,
  initialSyncs,
  canSend,
}: {
  importId: string;
  connections: PublicConnection[];
  initialSyncs: PublicSync[];
  canSend: boolean;
}) {
  const [syncs, setSyncs] = useState(initialSyncs);
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  const [updateMode, setUpdateMode] =
    useState<SyncOptions["updateMode"]>("price_stock");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const driving = useRef(new Set<string>());

  const upsert = (sync: PublicSync) =>
    setSyncs((current) => [
      sync,
      ...current.filter((item) => item.id !== sync.id),
    ]);

  /** Vercel has no background work: the open page drives the sync. */
  async function drive(id: string, action: "advance" | "resume" = "advance") {
    if (driving.current.has(id)) return;
    driving.current.add(id);
    try {
      for (let round = 0; round < 200; round++) {
        const response = await fetch(`/api/store-syncs/${id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: round === 0 ? action : "advance" }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        upsert(data.sync);
        if (!active(data.sync)) break;
        // Another runner (worker, other tab) owns it: poll instead of racing.
        if (data.sync.status === "running")
          await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Envoi interrompu.");
    } finally {
      driving.current.delete(id);
    }
  }

  useEffect(() => {
    if (!canSend) return;
    // Resumes a sync left unfinished (tab closed, deadline reached).
    const timer = setTimeout(() => {
      for (const sync of initialSyncs) if (active(sync)) void drive(sync.id);
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start(dryRun: boolean) {
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/imports/${importId}/store-syncs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId, updateMode, dryRun }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      upsert(data.sync);
      await drive(data.sync.id);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Envoi impossible.");
    } finally {
      setPending(false);
    }
  }

  const label = (id: string) =>
    connections.find((connection) => connection.id === id)?.label ??
    "Boutique supprimée";

  return (
    <section className="panel export-form store-panel">
      <div className="panel-heading">
        <div>
          <h2>Envoyer directement vers une boutique</h2>
          <p>
            Mise à jour par SKU. Les nouveaux produits sont créés en brouillon ;
            le statut des produits existants n’est jamais modifié.
          </p>
        </div>
        <Send size={20} />
      </div>
      {!connections.length ? (
        <div className="empty-state">
          <p>
            Aucune boutique connectée.{" "}
            <Link href="/settings">Connecter Shopify ou WooCommerce</Link>
          </p>
        </div>
      ) : (
        canSend && (
          <>
            <div className="form-section export-grid">
              <label>
                Boutique
                <select
                  value={connectionId}
                  onChange={(event) => setConnectionId(event.target.value)}
                >
                  {connections.map((connection) => (
                    <option value={connection.id} key={connection.id}>
                      {connection.label} ({STORE_PLATFORMS[connection.platform]}
                      {connection.currency ? `, ${connection.currency}` : ""})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Produits déjà présents
                <select
                  value={updateMode}
                  onChange={(event) =>
                    setUpdateMode(
                      event.target.value as SyncOptions["updateMode"],
                    )
                  }
                >
                  {Object.entries(SYNC_UPDATE_MODES).map(([value, text]) => (
                    <option value={value} key={value}>
                      {text}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="form-section export-footer">
              <span className="fine-print">
                Simulez d’abord : aucune écriture, seulement le nombre de
                créations et de mises à jour.
              </span>
              <div className="row-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={pending || !connectionId}
                  onClick={() => start(true)}
                >
                  <FlaskConical size={16} />
                  Simuler
                </button>
                <button
                  type="button"
                  className="button primary"
                  disabled={pending || !connectionId}
                  onClick={() => start(false)}
                >
                  {pending ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <Send size={16} />
                  )}
                  {pending ? "Envoi…" : "Envoyer"}
                </button>
              </div>
            </div>
          </>
        )
      )}
      {error && (
        <p role="alert" className="alert error">
          {error}
        </p>
      )}
      {!!syncs.length && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Boutique</th>
                <th>Type</th>
                <th>Statut</th>
                <th>Créés</th>
                <th>Mis à jour</th>
                <th>Ignorés</th>
                <th>Erreurs</th>
              </tr>
            </thead>
            <tbody>
              {syncs.map((sync) => {
                const done =
                  sync.counts.created +
                  sync.counts.updated +
                  sync.counts.skipped +
                  sync.counts.failed;
                return (
                  <tr key={sync.id}>
                    <td>{label(sync.connectionId)}</td>
                    <td>
                      {sync.dryRun ? "Simulation" : "Envoi"} ·{" "}
                      {sync.updateMode === "all"
                        ? "fiche complète"
                        : "prix et stock"}
                    </td>
                    <td>
                      {STATUS[sync.status]}
                      {active(sync) && sync.total > 0 && (
                        <>
                          {" "}
                          ·{" "}
                          {Math.min(
                            100,
                            Math.round((done / sync.total) * 100),
                          )}{" "}
                          %
                        </>
                      )}
                      {sync.error && (
                        <>
                          <br />
                          <small className="danger-text">{sync.error}</small>
                        </>
                      )}
                      {sync.status === "failed" && canSend && (
                        <>
                          <br />
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => drive(sync.id, "resume")}
                          >
                            <RotateCcw size={13} /> Reprendre
                          </button>
                        </>
                      )}
                    </td>
                    <td>{sync.counts.created}</td>
                    <td>{sync.counts.updated}</td>
                    <td>{sync.counts.skipped}</td>
                    <td>
                      {sync.counts.failed}
                      {!!sync.errors.length && (
                        <details>
                          <summary>Détail</summary>
                          <ul>
                            {sync.errors.map((item) => (
                              <li key={`${item.line}-${item.message}`}>
                                Ligne {item.line} ({item.sku}) : {item.message}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
