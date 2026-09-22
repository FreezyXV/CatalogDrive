import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download, Settings2 } from "lucide-react";
import { requirePageIdentity } from "@/server/auth";
import { qualityRows } from "@/server/catalog";
import { listExports } from "@/server/exports";
import { HttpError } from "@/server/http";
import { QualityReview } from "@/components/quality-review";
export default async function QualityPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const actor = await requirePageIdentity();
  const { id } = await params;
  const filter = (await searchParams).status;
  const { job, rows } = await qualityRows(actor, id, filter).catch((error) => {
    if (error instanceof HttpError && error.status === 404) notFound();
    throw error;
  });
  const exports = await listExports(actor, id);
  const counts = job.counts ?? {
    total: 0,
    valid: 0,
    ambiguous: 0,
    invalid: 0,
    excluded: 0,
    duplicates: 0,
    transformed: 0,
  };
  if (job.status !== "ready")
    return (
      <>
        <Link href={`/imports/${id}/mapping`} className="back-link">
          <ArrowLeft size={15} />
          Mapping
        </Link>
        <div className="panel empty-state">
          <h1>
            {job.status === "failed"
              ? "Le traitement a échoué."
              : "Traitement en cours…"}
          </h1>
          <p>
            {job.error ??
              `${job.processedCount} ligne(s) enregistrée(s). Rechargez cette page dans quelques instants.`}
          </p>
          <Link className="button secondary" href={`/imports/${id}/mapping`}>
            Revenir au mapping
          </Link>
        </div>
      </>
    );
  return (
    <>
      <Link href={`/imports/${id}`} className="back-link">
        <ArrowLeft size={15} />
        Diagnostic
      </Link>
      <div className="page-heading">
        <div>
          <span className="eyebrow">04 / CONTRÔLER LA QUALITÉ</span>
          <h1>Rapport et validation</h1>
          <p>
            {counts.total} lignes traitées · {counts.transformed} lignes
            transformées
          </p>
        </div>
        <Link href={`/imports/${id}/export`} className="button primary">
          <Download size={17} />
          Configurer l’export
        </Link>
      </div>
      <section className="stats-grid four">
        {(
          [
            ["valid", "Valides", counts.valid],
            ["ambiguous", "Ambiguës", counts.ambiguous],
            ["invalid", "Invalides", counts.invalid],
            ["excluded", "Exclues", counts.excluded],
          ] as const
        ).map(([key, label, count]) => (
          <Link
            href={`/imports/${id}/quality?status=${key}`}
            className="stat"
            key={key}
          >
            <span>{label}</span>
            <strong>{count}</strong>
            <small>Ouvrir cette file</small>
          </Link>
        ))}
      </section>
      <div className="filter-bar">
        <Link
          href={`/imports/${id}/quality`}
          className={!filter ? "active" : ""}
        >
          Toutes
        </Link>
        <span>{counts.duplicates} doublon(s) à vérifier</span>
        <span>{exports.length} export(s) créé(s)</span>
        <Link href={`/imports/${id}/mapping`}>
          <Settings2 size={14} />
          Configuration
        </Link>
      </div>
      <QualityReview
        id={id}
        initialRows={
          rows as unknown as Parameters<typeof QualityReview>[0]["initialRows"]
        }
      />
    </>
  );
}
