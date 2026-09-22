"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, LoaderCircle, Plus, Trash2 } from "lucide-react";
import {
  PROFILES,
  defaultExportConfig,
  exportFieldLabel,
  type ExportConfig,
} from "@/domain/exports";
import { fieldKeys } from "@/domain/catalog";

type ColumnField = ExportConfig["columns"][number]["field"];

export function ExportForm({
  importId,
  templates = [],
}: {
  importId: string;
  templates?: { id: string; name: string; config: ExportConfig }[];
}) {
  const router = useRouter();
  const [config, setConfig] = useState<ExportConfig>(
    defaultExportConfig("generic"),
  );
  const [templateName, setTemplateName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const fields = useMemo(
    () =>
      [
        ...fieldKeys,
        "source_row_number",
        "validation_status",
        "confidence_score",
      ] as ColumnField[],
    [],
  );

  function updateColumn(
    index: number,
    change: Partial<ExportConfig["columns"][number]>,
  ) {
    setConfig((current) => ({
      ...current,
      columns: current.columns.map((column, position) =>
        position === index ? { ...column, ...change } : column,
      ),
    }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/imports/${importId}/catalog`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "export",
          config,
          templateName: templateName.trim() || undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      router.refresh();
      const download = document.createElement("a");
      download.href = `/api/exports/${data.export.id}/file`;
      download.click();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Export impossible.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="panel export-form" onSubmit={submit}>
      <div className="panel-heading">
        <div>
          <h2>Format de destination</h2>
          <p>
            Les lignes invalides, ambiguës ou exclues restent hors du fichier
            final.
          </p>
        </div>
        <Download size={20} />
      </div>
      <div className="form-section export-grid">
        {!!templates.length && (
          <label>
            Modèle enregistré
            <select
              defaultValue=""
              onChange={(event) => {
                const template = templates.find(
                  (item) => item.id === event.target.value,
                );
                if (template) {
                  setConfig(template.config);
                  setTemplateName(template.name);
                }
              }}
            >
              <option value="">Sélectionner un modèle</option>
              {templates.map((template) => (
                <option value={template.id} key={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Profil
          <select
            value={config.profile}
            onChange={(event) =>
              setConfig(
                defaultExportConfig(
                  event.target.value as ExportConfig["profile"],
                ),
              )
            }
          >
            {Object.entries(PROFILES).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Séparateur
          <select
            value={config.delimiter}
            disabled={["woocommerce", "shopify"].includes(config.profile)}
            onChange={(event) =>
              setConfig({
                ...config,
                delimiter: event.target.value as ExportConfig["delimiter"],
              })
            }
          >
            <option value=";">Point-virgule</option>
            <option value=",">Virgule</option>
            <option value="\t">Tabulation</option>
          </select>
        </label>
        <label>
          Encodage
          <select
            value={config.encoding}
            onChange={(event) =>
              setConfig({
                ...config,
                encoding: event.target.value as ExportConfig["encoding"],
              })
            }
          >
            <option value="utf-8-bom">UTF-8 avec BOM</option>
            <option value="utf-8">UTF-8</option>
            <option value="windows-1252">Windows-1252</option>
          </select>
        </label>
        <label>
          Convention de prix
          <select
            value={config.priceBasis}
            onChange={(event) =>
              setConfig({
                ...config,
                priceBasis: event.target.value as ExportConfig["priceBasis"],
              })
            }
          >
            <option value="excl_tax">Hors taxes</option>
            <option value="incl_tax">Toutes taxes comprises</option>
          </select>
        </label>
      </div>
      <div className="form-section">
        <div className="section-title">
          <div>
            <h3>Colonnes du fichier</h3>
            <p>L’ordre ci-dessous est celui de l’export.</p>
          </div>
          <button
            type="button"
            className="button secondary"
            onClick={() =>
              setConfig({
                ...config,
                columns: [
                  ...config.columns,
                  { field: "sku", header: "Nouvelle colonne" },
                ],
              })
            }
          >
            <Plus size={15} />
            Ajouter
          </button>
        </div>
        <div className="column-editor">
          {config.columns.map((column, index) => (
            <div className="column-row" key={`${index}-${column.field}`}>
              <select
                value={column.field}
                onChange={(event) =>
                  updateColumn(index, {
                    field: event.target.value as ColumnField,
                  })
                }
              >
                {fields.map((field) => (
                  <option value={field} key={field}>
                    {exportFieldLabel(field)}
                  </option>
                ))}
              </select>
              <input
                aria-label={`En-tête de la colonne ${index + 1}`}
                value={column.header}
                maxLength={100}
                onChange={(event) =>
                  updateColumn(index, { header: event.target.value })
                }
              />
              <button
                type="button"
                className="icon-button"
                aria-label={`Retirer la colonne ${index + 1}`}
                disabled={config.columns.length === 1}
                onClick={() =>
                  setConfig({
                    ...config,
                    columns: config.columns.filter(
                      (_, position) => position !== index,
                    ),
                  })
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      </div>
      <div className="form-section export-footer">
        <label>
          Enregistrer comme modèle (facultatif)
          <input
            value={templateName}
            maxLength={80}
            placeholder="Ex. Import WooCommerce atelier"
            onChange={(event) => setTemplateName(event.target.value)}
          />
        </label>
        <button
          className="button primary"
          disabled={pending || !config.columns.length}
        >
          {pending ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <Download size={17} />
          )}
          {pending ? "Création…" : "Créer et télécharger"}
        </button>
      </div>
      {error && (
        <p role="alert" className="alert error">
          {error}
        </p>
      )}
    </form>
  );
}
