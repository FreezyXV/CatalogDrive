"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, LoaderCircle, RefreshCw, Save } from "lucide-react";
import {
  DEFAULT_RULES,
  FIELDS,
  fieldKeys,
  suggestMapping,
  type Mapping,
  type ReadOptions,
  type RuleConfig,
} from "@/domain/catalog";
import type { Diagnostic } from "@/domain/csv";

type Template = {
  id: string;
  name: string;
  headers: string[];
  mapping: Mapping;
  readOptions: ReadOptions;
  rules: RuleConfig;
};
export function MappingForm({
  id,
  initial,
  initialMapping,
  initialOptions,
  initialRules,
  templates = [],
}: {
  id: string;
  initial: Diagnostic;
  initialMapping?: Mapping | null;
  initialOptions?: ReadOptions;
  initialRules?: RuleConfig | null;
  templates?: Template[];
}) {
  const router = useRouter();
  const [diagnostic, setDiagnostic] = useState(initial);
  const [mapping, setMapping] = useState<Mapping>(
    initialMapping ?? suggestMapping(initial.headers),
  );
  const [options, setOptions] = useState<ReadOptions>(
    initialOptions ?? {
      headerLine: initial.headerLine,
      delimiter:
        initial.format === "csv"
          ? (initial.delimiter as "," | ";" | "\t")
          : undefined,
      encoding: initial.encoding,
      sheet: initial.sheet,
    },
  );
  const [rules, setRules] = useState<RuleConfig>(initialRules ?? DEFAULT_RULES);
  const [templateName, setTemplateName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<"inspect" | "save" | "process" | null>(
    null,
  );
  const columnOwners = useMemo(
    () =>
      new Map(Object.entries(mapping).map(([field, index]) => [index, field])),
    [mapping],
  );
  async function command(body: object) {
    const response = await fetch(`/api/imports/${id}/catalog`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
  }
  async function inspect() {
    setPending("inspect");
    setError("");
    try {
      const data = await command({ action: "inspect", options });
      setDiagnostic(data.diagnostic);
      setMapping(data.mapping);
      setOptions({
        ...options,
        headerLine: data.diagnostic.headerLine,
        sheet: data.diagnostic.sheet,
        delimiter:
          data.diagnostic.format === "csv"
            ? data.diagnostic.delimiter
            : undefined,
        encoding: data.diagnostic.encoding,
      });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setPending(null);
    }
  }
  async function save() {
    setPending("save");
    setError("");
    try {
      await command({
        action: "mapping",
        mapping,
        rules,
        options,
        templateName: templateName || undefined,
      });
      router.refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setPending(null);
    }
  }
  async function process() {
    setPending("process");
    setError("");
    try {
      await command({
        action: "mapping",
        mapping,
        rules,
        options,
        templateName: templateName || undefined,
      });
      await command({ action: "process" });
      router.push(`/imports/${id}/quality`);
      router.refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setPending(null);
    }
  }
  function assign(field: string, index: number | undefined) {
    setMapping((current) => {
      const next = { ...current };
      delete next[field as keyof Mapping];
      if (index !== undefined) {
        const owner = Object.entries(next).find(
          ([, value]) => value === index,
        )?.[0];
        if (owner) delete next[owner as keyof Mapping];
        next[field as keyof Mapping] = index;
      }
      return next;
    });
  }
  function applyTemplate(id: string) {
    const template = templates.find((item) => item.id === id);
    if (!template) return;
    const next: Mapping = {};
    for (const [field, index] of Object.entries(template.mapping)) {
      const header = template.headers[index];
      const currentIndex = diagnostic.headers.findIndex(
        (value) => value.trim().toLowerCase() === header?.trim().toLowerCase(),
      );
      if (currentIndex >= 0) next[field as keyof Mapping] = currentIndex;
    }
    setMapping(next);
    setRules(template.rules);
    setTemplateName(template.name);
  }
  return (
    <div className="flow-stack">
      <section className="panel form-panel">
        <div className="panel-heading">
          <div>
            <h2>Structure du fichier</h2>
            <p>
              Vérifiez la feuille, la ligne d’en-tête et le décodage avant le
              mapping.
            </p>
          </div>
          <button
            className="button secondary"
            onClick={inspect}
            disabled={!!pending}
          >
            <RefreshCw size={16} />
            {pending === "inspect" ? "Analyse…" : "Réanalyser"}
          </button>
        </div>
        <div className="settings-grid">
          {!!templates.length && (
            <label>
              Modèle fournisseur
              <select
                defaultValue=""
                onChange={(e) => applyTemplate(e.target.value)}
              >
                <option value="">Sélectionner un modèle</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {diagnostic.sheets && (
            <label>
              Feuille
              <select
                value={options.sheet ?? ""}
                onChange={(e) =>
                  setOptions({ ...options, sheet: e.target.value })
                }
              >
                {diagnostic.sheets.map((sheet) => (
                  <option key={sheet}>{sheet}</option>
                ))}
              </select>
            </label>
          )}
          <label>
            Ligne d’en-tête
            <input
              type="number"
              min={1}
              max={1000}
              value={options.headerLine ?? 1}
              onChange={(e) =>
                setOptions({ ...options, headerLine: Number(e.target.value) })
              }
            />
          </label>
          {diagnostic.format !== "xlsx" && (
            <>
              <label>
                Encodage
                <select
                  value={options.encoding ?? "utf-8"}
                  onChange={(e) =>
                    setOptions({
                      ...options,
                      encoding: e.target.value as ReadOptions["encoding"],
                    })
                  }
                >
                  <option value="utf-8">UTF-8</option>
                  <option value="utf-16le">UTF-16LE</option>
                  <option value="windows-1252">Windows-1252</option>
                </select>
              </label>
              <label>
                Séparateur
                <select
                  value={options.delimiter ?? ";"}
                  onChange={(e) =>
                    setOptions({
                      ...options,
                      delimiter: e.target.value as ReadOptions["delimiter"],
                    })
                  }
                >
                  <option value=";">Point-virgule</option>
                  <option value=",">Virgule</option>
                  <option value="\t">Tabulation</option>
                </select>
              </label>
            </>
          )}
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Mapping vers le catalogue standard</h2>
            <p>
              Une colonne source ne peut alimenter qu’un champ. Désignation et
              SKU/référence sont obligatoires.
            </p>
          </div>
          <span className="count-badge">
            {Object.keys(mapping).length} CHAMPS
          </span>
        </div>
        <div className="mapping-grid">
          {fieldKeys.map((field) => (
            <label key={field}>
              <span>{FIELDS[field]}</span>
              <select
                aria-label={FIELDS[field]}
                value={mapping[field] ?? ""}
                onChange={(e) =>
                  assign(
                    field,
                    e.target.value === "" ? undefined : Number(e.target.value),
                  )
                }
              >
                <option value="">Ignorer</option>
                {diagnostic.headers.map((header, index) => (
                  <option
                    key={index}
                    value={index}
                    disabled={
                      columnOwners.has(index) &&
                      columnOwners.get(index) !== field
                    }
                  >
                    {index + 1}. {header || "Colonne sans nom"} ·{" "}
                    {diagnostic.columnTypes?.[index] ?? "type inconnu"}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </section>
      <section className="panel form-panel">
        <div className="panel-heading">
          <div>
            <h2>Règles métier</h2>
            <p>Ces choix sont enregistrés avec chaque transformation.</p>
          </div>
        </div>
        <div className="settings-grid">
          <label>
            Devise par défaut
            <select
              value={rules.defaultCurrency}
              onChange={(e) =>
                setRules({
                  ...rules,
                  defaultCurrency: e.target
                    .value as RuleConfig["defaultCurrency"],
                })
              }
            >
              {[
                "EUR",
                "USD",
                "GBP",
                "CHF",
                "CAD",
                "MAD",
                "TND",
                "DZD",
                "PLN",
                "CZK",
                "SEK",
                "NOK",
                "DKK",
                "RON",
                "BGN",
                "HUF",
                "TRY",
                "JPY",
                "CNY",
                "AUD",
              ].map((currency) => (
                <option key={currency}>{currency}</option>
              ))}
            </select>
          </label>
          <label>
            Convention des prix
            <select
              value={rules.priceBasis}
              onChange={(e) =>
                setRules({
                  ...rules,
                  priceBasis: e.target.value as RuleConfig["priceBasis"],
                })
              }
            >
              <option value="excl_tax">Hors taxes</option>
              <option value="incl_tax">Toutes taxes comprises</option>
            </select>
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={rules.stripReferenceSeparators}
              onChange={(e) =>
                setRules({
                  ...rules,
                  stripReferenceSeparators: e.target.checked,
                })
              }
            />
            Proposer les références sans séparateurs
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={rules.normalizeBrands}
              onChange={(e) =>
                setRules({ ...rules, normalizeBrands: e.target.checked })
              }
            />
            Uniformiser la casse des marques
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={rules.fuzzyDuplicates}
              onChange={(e) =>
                setRules({ ...rules, fuzzyDuplicates: e.target.checked })
              }
            />
            Détecter les doublons probables
          </label>
          <label>
            Nom du modèle fournisseur
            <input
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="Optionnel · ex. Fournisseur Martin"
              maxLength={80}
            />
          </label>
        </div>
      </section>
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      <div className="action-bar">
        <button
          className="button secondary"
          onClick={save}
          disabled={!!pending}
        >
          <Save size={16} />
          {pending === "save" ? "Enregistrement…" : "Enregistrer le mapping"}
        </button>
        <button
          className="button primary"
          onClick={process}
          disabled={!!pending}
        >
          {pending === "process" ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <ArrowRight size={17} />
          )}{" "}
          {pending === "process"
            ? "Traitement en cours…"
            : "Lancer le traitement"}
        </button>
      </div>
    </div>
  );
}
