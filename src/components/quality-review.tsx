"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Edit3, RotateCcw, Save, Trash2, X } from "lucide-react";
import type { Issue } from "@/domain/catalog";
type Row = {
  id: string;
  sourceLine: number;
  data: Record<string, string>;
  raw: string[];
  transformations: {
    field: string;
    original: string;
    value: string;
    rule: string;
    version: string;
  }[];
  issues: Issue[];
  decisions: unknown[];
  status: string;
  excluded: number;
  version: number;
  confidence: string;
};
export function QualityReview({
  id,
  initialRows,
}: {
  id: string;
  initialRows: Row[];
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");
  async function decide(
    row: Row,
    decision: "accept" | "edit" | "keep" | "exclude" | "restore" | "reset",
    issue?: Issue,
  ) {
    setError("");
    try {
      const response = await fetch(`/api/imports/${id}/catalog`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "review",
          rowId: row.id,
          version: row.version,
          decision,
          issueId: issue?.id,
          value: decision === "edit" ? value : undefined,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      const refreshed = await fetch(`/api/imports/${id}/catalog?status=all`);
      const data = await refreshed.json();
      setRows(data.rows);
      setEditing(null);
      router.refresh();
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <div className="flow-stack">
      {error && (
        <div role="alert" className="alert error">
          {error}
        </div>
      )}
      {!rows.length ? (
        <div className="panel empty-state">
          <h3>Aucune ligne dans cette file.</h3>
          <p>Utilisez les filtres du rapport pour changer de catégorie.</p>
        </div>
      ) : (
        rows.map((row) => (
          <article
            key={row.id}
            className={`panel issue-card ${row.excluded ? "is-excluded" : ""}`}
          >
            <div className="issue-card-head">
              <div>
                <span
                  className={`status-badge ${row.status === "valid" ? "success" : row.status === "invalid" ? "error" : "warning"}`}
                >
                  {row.excluded ? "Exclue" : row.status}
                </span>
                <strong>Ligne source {row.sourceLine}</strong>
                <small>
                  Confiance {Math.round(Number(row.confidence) * 100)} % ·
                  version {row.version}
                </small>
              </div>
              <div className="row-actions">
                {row.excluded ? (
                  <button
                    className="button secondary"
                    onClick={() => decide(row, "restore")}
                  >
                    <RotateCcw size={15} />
                    Restaurer
                  </button>
                ) : (
                  <button
                    className="button secondary danger-text"
                    onClick={() => decide(row, "exclude")}
                  >
                    <Trash2 size={15} />
                    Exclure
                  </button>
                )}
                <button
                  className="icon-button"
                  title="Revenir au traitement initial"
                  onClick={() => decide(row, "reset")}
                >
                  <RotateCcw size={15} />
                </button>
              </div>
            </div>
            <div className="data-summary">
              {Object.entries(row.data)
                .filter(([, v]) => v)
                .slice(0, 8)
                .map(([field, v]) => (
                  <div key={field}>
                    <span>{field}</span>
                    <strong>{v}</strong>
                  </div>
                ))}
            </div>
            {row.issues.map((issue) => (
              <div className="issue-line" key={issue.id}>
                <div>
                  <span className={`severity ${issue.severity}`}>
                    {issue.severity}
                  </span>
                  <strong>{issue.message}</strong>
                  <small>
                    Original : {issue.original || "∅"}
                    {issue.score !== undefined ? ` · score ${issue.score}` : ""}
                  </small>
                  {issue.suggestion !== undefined && (
                    <small>Suggestion : {issue.suggestion}</small>
                  )}
                </div>
                <div className="issue-actions">
                  {issue.suggestion !== undefined && (
                    <button
                      className="button primary"
                      onClick={() => decide(row, "accept", issue)}
                    >
                      <Check size={14} />
                      Accepter
                    </button>
                  )}
                  <button
                    className="button secondary"
                    onClick={() => {
                      setEditing(
                        editing === `${row.id}:${issue.id}`
                          ? null
                          : `${row.id}:${issue.id}`,
                      );
                      setValue(issue.suggestion ?? issue.original);
                    }}
                  >
                    <Edit3 size={14} />
                    Modifier
                  </button>
                  <button
                    className="button secondary"
                    onClick={() => decide(row, "keep", issue)}
                  >
                    <X size={14} />
                    Conserver
                  </button>
                </div>
                {editing === `${row.id}:${issue.id}` && (
                  <div className="inline-edit">
                    <input
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      maxLength={65536}
                    />
                    <button
                      className="button primary"
                      onClick={() => decide(row, "edit", issue)}
                    >
                      <Save size={14} />
                      Valider
                    </button>
                  </div>
                )}
              </div>
            ))}
            {!!row.transformations.length && (
              <details className="transformations">
                <summary>
                  {row.transformations.length} transformation(s) explicable(s)
                </summary>
                {row.transformations.map((change, index) => (
                  <div key={index}>
                    <code>{change.field}</code>
                    <span>
                      {change.original || "∅"} → {change.value || "∅"}
                    </span>
                    <small>
                      {change.rule}@{change.version}
                    </small>
                  </div>
                ))}
              </details>
            )}
          </article>
        ))
      )}
    </div>
  );
}
