import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download, Settings2 } from "lucide-react";
import { requirePageIdentity } from "@/server/auth";
import { qualityRows } from "@/server/catalog";
import { listExports } from "@/server/exports";
import { LIMITS } from "@/domain/csv";
import { HttpError } from "@/server/http";
import { QualityReview } from "@/components/quality-review";
export default async function QualityPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const actor = await requirePageIdentity();
  const { id } = await params;
  const query = await searchParams;
  const filter = ["valid", "ambiguous", "invalid", "excluded"].includes(
    query.status ?? "",
  )
    ? query.status
    : undefined;
  const page = Number(query.page ?? 1);
  if (!Number.isInteger(page) || page < 1 || page > Math.ceil(LIMITS.rows / 50))
    notFound();
  const { job, rows } = await qualityRows(actor, id, filter, page).catch(
    (error) => {
      if (error instanceof HttpError && error.status === 404) notFound();
      throw error;
    },
  );
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
  const selectedCount = filter
    ? counts[filter as "valid" | "ambiguous" | "invalid" | "excluded"]
    : counts.total;
  const pages = Math.max(1, Math.ceil(selectedCount / 50));
  const pageUrl = (number: number) =>
    `/imports/${id}/quality?${new URLSearchParams({ ...(filter ? { status: filter } : {}), page: String(number) })}`;
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
      <nav className="filter-bar" aria-label="Pagination des lignes">
        {page > 1 && <Link href={pageUrl(page - 1)}>Page précédente</Link>}
        <span>
          Page {page} sur {pages} · 50 lignes par page
        </span>
        {page < pages && <Link href={pageUrl(page + 1)}>Page suivante</Link>}
        {page < pages - 1 && <Link href={pageUrl(pages)}>Dernière page</Link>}
      </nav>
      <QualityReview
        key={`${id}:${filter ?? "all"}:${page}`}
        id={id}
        filter={filter}
        page={page}
        initialRows={
          rows as unknown as Parameters<typeof QualityReview>[0]["initialRows"]
        }
      />
    </>
  );
}
