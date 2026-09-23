import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Clock3,
  Database,
  FileSpreadsheet,
  Files,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { requirePageIdentity } from "@/server/auth";
import { listImports } from "@/server/imports";
const number = (value: number) => new Intl.NumberFormat("fr-FR").format(value);
export default async function Dashboard() {
  const identity = await requirePageIdentity();
  const imports = await listImports(identity);
  const rows = imports.reduce(
    (total, { job }) => total + job.diagnostic.rowCount,
    0,
  );
  const bytes = imports.reduce((total, { file }) => total + file.sizeBytes, 0);
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">VOTRE ATELIER CATALOGUE</span>
          <h1>Vue d’ensemble</h1>
          <p>Une vue claire sur vos fichiers, dès leur arrivée.</p>
        </div>
        <Link href="/imports/new" className="button primary">
          <Plus size={18} />
          Nouvel import
        </Link>
      </div>
      <section className="welcome-banner">
        <div>
          <span className="eyebrow">DE LA SOURCE À LA CLARTÉ</span>
          <h2>
            Faites le point sur
            <br />
            vos données fournisseurs.
          </h2>
          <p>
            Déposez un CSV, XLSX ou ZIP. Mappez, normalisez, contrôlez
            <br className="desktop-break" /> puis exportez vers votre outil
            cible.
          </p>
          <Link href="/imports/new">
            Analyser un fichier
            <ArrowRight size={17} />
          </Link>
        </div>
        <div className="banner-illustration" aria-hidden="true">
          <div className="sheet-back" />
          <div className="sheet-front">
            <div className="sheet-label">
              <FileSpreadsheet size={20} />
              FOURNISSEUR.CSV
            </div>
            {[1, 2, 3, 4].map((i) => (
              <div className="sheet-row" key={i}>
                <i />
                <i />
                <i />
              </div>
            ))}
            <span className="sheet-badge">
              <ShieldCheck size={16} />
              Original préservé
            </span>
          </div>
        </div>
      </section>
      <section
        className="stats-grid"
        aria-label="Statistiques des 100 derniers imports"
      >
        <div className="stat">
          <span>
            Fichiers importés
            <Files size={18} />
          </span>
          <strong>{number(imports.length)}</strong>
          <small>Sur les 100 derniers imports</small>
        </div>
        <div className="stat">
          <span>
            Lignes analysées
            <Database size={18} />
          </span>
          <strong>{number(rows)}</strong>
          <small>Sur les 100 derniers imports</small>
        </div>
        <div className="stat">
          <span>
            Stockage utilisé
            <ShieldCheck size={18} />
          </span>
          <strong>
            {new Intl.NumberFormat("fr-FR", {
              maximumFractionDigits: 1,
            }).format(bytes / 1024)}
            <em>Kio</em>
          </strong>
          <small>Sur les 100 derniers imports</small>
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Historique des imports</h2>
            <p>Vos 100 derniers fichiers, accessibles à tout moment.</p>
          </div>
          <span className="count-badge">
            {imports.length} fichier{imports.length > 1 ? "s" : ""}
          </span>
        </div>
        {!imports.length ? (
          <div className="empty-state">
            <span className="empty-icon">
              <Files size={29} strokeWidth={1.4} />
            </span>
            <h3>Votre atelier est prêt.</h3>
            <p>
              Importez votre premier fichier fournisseur
              <br />
              pour commencer à explorer vos données.
            </p>
            <Link href="/imports/new" className="button secondary">
              Importer un fichier
              <ArrowRight size={16} />
            </Link>
            <a href="/demo/fournisseur-demo.csv" download className="demo-link">
              Télécharger un CSV de démonstration
            </a>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Fichier fournisseur</th>
                  <th>Importé le</th>
                  <th>Lignes</th>
                  <th>État de lecture</th>
                  <th>
                    <span className="sr-only">Ouvrir</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {imports.map(({ job, file }) => (
                  <tr key={job.id}>
                    <td>
                      <Link
                        className="filename-link"
                        href={`/imports/${job.id}`}
                      >
                        <span className="file-icon">
                          <FileSpreadsheet size={19} />
                        </span>
                        <span>
                          {file.originalName}
                          <small>
                            {(job.diagnostic.format ?? "csv").toUpperCase()} ·{" "}
                            {job.diagnostic.headers.length} colonnes
                            {job.archiveEntry
                              ? ` · ZIP : ${job.archiveEntry}`
                              : ""}
                          </small>
                        </span>
                      </Link>
                    </td>
                    <td className="muted">
                      {new Intl.DateTimeFormat("fr-FR", {
                        dateStyle: "medium",
                        timeStyle: "short",
                        timeZone: "Europe/Paris",
                      }).format(job.createdAt)}
                    </td>
                    <td className="tabular">
                      {number(job.diagnostic.rowCount)}
                    </td>
                    <td>
                      <span
                        className={`status-badge ${job.diagnostic.warnings.length ? "warning" : "success"}`}
                      >
                        {job.diagnostic.warnings.length
                          ? "À vérifier"
                          : job.status === "ready"
                            ? "Prêt"
                            : "Analysé"}
                      </span>
                    </td>
                    <td>
                      <Link
                        className="icon-button"
                        href={`/imports/${job.id}`}
                        aria-label={`Ouvrir ${file.originalName}`}
                      >
                        <ArrowUpRight size={18} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <div className="footnote">
        <Clock3 size={15} />
        Le fichier original, les transformations et les décisions manuelles
        restent traçables jusqu’à l’export.
      </div>
    </>
  );
}
