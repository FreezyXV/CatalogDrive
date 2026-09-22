import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  ArrowRight,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { requirePageIdentity } from "@/server/auth";
import { getImport } from "@/server/imports";
import { HttpError } from "@/server/http";
import { DeleteImport } from "@/components/workspace-actions";
export default async function ImportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const identity = await requirePageIdentity();
  const { id } = await params;
  const result = await getImport(identity, id).catch((error) => {
    if (error instanceof HttpError && error.status === 404) notFound();
    throw error;
  });
  const { job, file } = result;
  const d = job.diagnostic;
  const maxColumns = Math.max(
    d.headers.length,
    ...d.preview.map((row) => row.values.length),
  );
  return (
    <>
      <Link href="/dashboard" className="back-link">
        <ArrowLeft size={15} />
        Historique des imports
      </Link>
      <div className="page-heading">
        <div>
          <span className="eyebrow">02 / COMPRENDRE LA SOURCE</span>
          <h1>Diagnostic du fichier</h1>
          <p className="filename-heading">
            <FileSpreadsheet size={18} />
            {file.originalName}
          </p>
        </div>
        <a className="button secondary" href={`/api/imports/${id}/original`}>
          <Download size={17} />
          Télécharger l’original
        </a>
      </div>
      <div
        className={`analysis-result ${d.warnings.length ? "has-warning" : ""}`}
      >
        {d.warnings.length ? (
          <TriangleAlert size={23} />
        ) : (
          <CheckCircle2 size={23} />
        )}
        <div>
          <strong>
            {d.warnings.length
              ? "Analyse terminée · structure à vérifier"
              : "Analyse terminée · fichier lisible"}
          </strong>
          <p>
            Votre original est conservé. Aucune valeur n’a été corrigée ou
            normalisée.
          </p>
        </div>
        <span className="status-badge neutral">
          {(d.format ?? "csv").toUpperCase()}
        </span>
      </div>
      <section className="stats-grid four" aria-label="Diagnostic">
        <div className="stat">
          <span>Lignes de données</span>
          <strong>{new Intl.NumberFormat("fr-FR").format(d.rowCount)}</strong>
          <small>Hors en-tête et lignes physiques vides</small>
        </div>
        <div className="stat">
          <span>Colonnes détectées</span>
          <strong>{d.headers.length}</strong>
          <small>Selon la première ligne non vide</small>
        </div>
        <div className="stat">
          <span>Encodage</span>
          <strong className="stat-text">{d.encoding.toUpperCase()}</strong>
          <small>{d.encodingNote}</small>
        </div>
        <div className="stat">
          <span>{d.format === "xlsx" ? "Feuille" : "Séparateur"}</span>
          <strong className="stat-text">
            {d.format === "xlsx"
              ? (d.sheet ?? "Première feuille")
              : d.delimiter === ";"
                ? "Point-virgule"
                : d.delimiter === ","
                  ? "Virgule"
                  : "Tabulation"}
          </strong>
          <small>
            {d.format === "xlsx"
              ? "Sélectionnée pour le mapping"
              : "Détecté dans l’en-tête"}
          </small>
        </div>
      </section>
      {!!d.warnings.length && (
        <div className="alert warning-box">
          <TriangleAlert size={20} />
          <div>
            <strong>Points à vérifier</strong>
            <ul>
              {d.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <section className="panel preview-panel">
        <div className="panel-heading">
          <div>
            <h2>Aperçu des données brutes</h2>
            <p>
              {d.preview.length} première{d.preview.length > 1 ? "s" : ""} ligne
              {d.preview.length > 1 ? "s" : ""} de données · Aucun mapping
              appliqué
            </p>
          </div>
          <span className="count-badge">LECTURE SEULE</span>
        </div>
        <div className="table-scroll">
          <table className="preview-table">
            <thead>
              <tr>
                <th scope="col">Ligne source¹</th>
                {Array.from({ length: maxColumns }, (_, i) => (
                  <th scope="col" key={i}>
                    <span className="column-index">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    {d.headers[i] ||
                      `Colonne ${i + 1} ${i >= d.headers.length ? "(hors en-tête)" : "(sans nom)"}`}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.preview.map((row) => (
                <tr
                  key={row.line}
                  className={
                    row.values.length !== d.headers.length
                      ? "irregular-row"
                      : ""
                  }
                >
                  <td className="source-line">{row.line}</td>
                  {Array.from({ length: maxColumns }, (_, i) => (
                    <td key={i}>
                      <span className="raw-cell">
                        {row.values[i] === undefined ? (
                          <span className="missing-value">Absent</span>
                        ) : row.values[i] === "" ? (
                          <span className="missing-value">Vide</span>
                        ) : (
                          row.values[i]
                        )}
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="preview-caption">
          ¹ Numéro de la ligne source. Pour un CSV, il correspond à la ligne
          physique où se termine l’enregistrement, valeurs multilignes incluses.
        </div>
      </section>
      <div className="detail-bottom">
        <section className="panel preservation">
          <ShieldCheck size={23} />
          <div>
            <h3>Original préservé, octet pour octet</h3>
            <p>
              {file.sizeBytes.toLocaleString("fr-FR")} octets · Empreinte
              SHA-256
            </p>
            <code>{file.sha256}</code>
            <p className="fine-print">
              Le téléchargement restitue le fichier brut, formules éventuelles
              comprises. Utilisez un éditeur texte pour l’inspecter sans
              exécuter de formules.
            </p>
          </div>
        </section>
        <section className="next-milestone">
          <span className="eyebrow">ÉTAPE SUIVANTE</span>
          <h3>Donner un sens aux colonnes.</h3>
          <p>
            Vérifiez la structure, associez les colonnes au schéma standard et
            choisissez les règles de normalisation.
          </p>
          <Link href={`/imports/${id}/mapping`} className="button primary">
            Configurer le mapping <ArrowRight size={16} />
          </Link>
        </section>
      </div>
      <DeleteImport id={id} />
    </>
  );
}
