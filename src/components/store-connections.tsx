"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Plug, RefreshCw, Store, Trash2 } from "lucide-react";
import { STORE_PLATFORMS, type StorePlatform } from "@/domain/store-sync";
import type { PublicConnection } from "@/server/stores/connections";

const empty = {
  label: "",
  address: "",
  accessToken: "",
  consumerKey: "",
  consumerSecret: "",
};

export function StoreConnections({
  connections,
  canManage,
}: {
  connections: PublicConnection[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [platform, setPlatform] = useState<StorePlatform>("shopify");
  const [form, setForm] = useState(empty);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");

  async function call(key: string, url: string, init: RequestInit) {
    setPending(key);
    setError("");
    try {
      const response = await fetch(url, {
        ...init,
        headers: { "Content-Type": "application/json" },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      router.refresh();
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : "Action impossible.");
      return false;
    } finally {
      setPending("");
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const body =
      platform === "shopify"
        ? {
            platform,
            label: form.label,
            address: form.address,
            accessToken: form.accessToken,
          }
        : {
            platform,
            label: form.label,
            address: form.address,
            consumerKey: form.consumerKey,
            consumerSecret: form.consumerSecret,
          };
    if (
      await call("create", "/api/store-connections", {
        method: "POST",
        body: JSON.stringify(body),
      })
    )
      setForm(empty);
  }

  const field = (key: keyof typeof empty) => ({
    value: form[key],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      setForm({ ...form, [key]: event.target.value }),
  });

  return (
    <section className="panel form-panel store-panel">
      <div className="panel-heading">
        <div>
          <h2>Boutiques connectées</h2>
          <p>
            Envoyez un catalogue validé directement dans Shopify ou WooCommerce.
            Les nouveaux produits sont créés en brouillon.
          </p>
        </div>
        <Store size={20} />
      </div>
      {!connections.length ? (
        <div className="empty-state">
          <p>Aucune boutique connectée.</p>
        </div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Boutique</th>
                <th>Plateforme</th>
                <th>Devise</th>
                <th>Prix</th>
                <th>Clé</th>
                {canManage && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {connections.map((connection) => (
                <tr key={connection.id}>
                  <td>
                    <strong>{connection.label}</strong>
                    <br />
                    <small className="muted">{connection.address}</small>
                  </td>
                  <td>{STORE_PLATFORMS[connection.platform]}</td>
                  <td>{connection.currency ?? "—"}</td>
                  <td>
                    {connection.pricesIncludeTax === null
                      ? "—"
                      : connection.pricesIncludeTax
                        ? "TTC"
                        : "HT"}
                  </td>
                  <td className="tabular">{connection.secretHint}</td>
                  {canManage && (
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Tester ${connection.label}`}
                          disabled={!!pending}
                          onClick={() =>
                            call(
                              connection.id,
                              `/api/store-connections/${connection.id}`,
                              { method: "POST" },
                            )
                          }
                        >
                          {pending === connection.id ? (
                            <LoaderCircle className="spin" size={16} />
                          ) : (
                            <RefreshCw size={16} />
                          )}
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Déconnecter ${connection.label}`}
                          disabled={!!pending}
                          onClick={() =>
                            call(
                              connection.id,
                              `/api/store-connections/${connection.id}`,
                              { method: "DELETE" },
                            )
                          }
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canManage && (
        <form onSubmit={submit}>
          <div className="settings-grid">
            <label>
              Plateforme
              <select
                value={platform}
                onChange={(event) =>
                  setPlatform(event.target.value as StorePlatform)
                }
              >
                {Object.entries(STORE_PLATFORMS).map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Nom affiché
              <input
                required
                maxLength={80}
                placeholder="Ex. Boutique principale"
                {...field("label")}
              />
            </label>
            <label>
              {platform === "shopify"
                ? "Domaine Shopify"
                : "Adresse de la boutique"}
              <input
                required
                maxLength={300}
                placeholder={
                  platform === "shopify"
                    ? "boutique.myshopify.com"
                    : "https://www.boutique.fr"
                }
                {...field("address")}
              />
            </label>
            {platform === "shopify" ? (
              <label>
                Jeton Admin API
                <input
                  required
                  type="password"
                  autoComplete="off"
                  placeholder="shpat_…"
                  {...field("accessToken")}
                />
              </label>
            ) : (
              <>
                <label>
                  Clé client
                  <input
                    required
                    type="password"
                    autoComplete="off"
                    placeholder="ck_…"
                    {...field("consumerKey")}
                  />
                </label>
                <label>
                  Secret client
                  <input
                    required
                    type="password"
                    autoComplete="off"
                    placeholder="cs_…"
                    {...field("consumerSecret")}
                  />
                </label>
              </>
            )}
          </div>
          <div className="form-section export-footer">
            <span className="fine-print">
              {platform === "shopify"
                ? "Créez une app personnalisée dans Shopify (Paramètres → Applications) avec les accès write_products, read_locations, read_inventory et write_inventory."
                : "Créez une clé REST en lecture/écriture dans WooCommerce → Réglages → Avancé → API REST. Les permaliens doivent être activés."}{" "}
              Les clés sont chiffrées et ne sont plus jamais affichées.
            </span>
            <button className="button primary" disabled={!!pending}>
              {pending === "create" ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Plug size={16} />
              )}
              {pending === "create" ? "Vérification…" : "Connecter"}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
