import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download, FileCheck2 } from "lucide-react";
import { requirePageIdentity } from "@/server/auth";
import { qualityRows } from "@/server/catalog";
import { listExports, listExportTemplates } from "@/server/exports";
import { HttpError } from "@/server/http";
import { ExportForm } from "@/components/export-form";
import { PROFILES } from "@/domain/exports";

export default async function ExportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requirePageIdentity();
  const { id } = await params;
  const { job } = await qualityRows(actor, id).catch((error) => {
    if (error instanceof HttpError && error.status === 404) notFound();
    throw error;
  });
  if (job.status !== "ready") notFound();
  const [exports, templates] = await Promise.all([
    listExports(actor, id),
    listExportTemplates(actor),
  ]);
  const counts = job.counts!;
  return (
    <>
      <Link href={`/imports/${id}/quality`} className="back-link">
        <ArrowLeft size={15} />
        Rapport qualité
      </Link>
      <div className="page-heading">
        <div>
          <span className="eyebrow">05 / EXPORTER LE CATALOGUE</span>
          <h1>Export prêt pour votre destination</h1>
          <p>
            {counts.valid} ligne(s) actuellement exportables · les refus
            figurent dans le rapport.
          </p>
        </div>
        <span className="status-badge success">
          <FileCheck2 size={14} />
          Traçabilité incluse
        </span>
      </div>
      <ExportForm importId={id} templates={templates} />
      <section className="panel export-history">
        <div className="panel-heading">
          <div>
            <h2>Exports précédents</h2>
            <p>
              Chaque création reste téléchargeable avec son rapport de
              transformations.
            </p>
          </div>
          <span className="count-badge">{exports.length}</span>
        </div>
        {!exports.length ? (
          <div className="empty-state">
            <p>Aucun export créé pour cet import.</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Profil</th>
                  <th>Date</th>
                  <th>Lignes</th>
                  <th>Refusées</th>
                  <th>Téléchargements</th>
                </tr>
              </thead>
              <tbody>
                {exports.map((item) => (
                  <tr key={item.id}>
                    <td>{PROFILES[item.config.profile]}</td>
                    <td>
                      {new Intl.DateTimeFormat("fr-FR", {
                        dateStyle: "medium",
                        timeStyle: "short",
                        timeZone: "Europe/Paris",
                      }).format(item.createdAt)}
                    </td>
                    <td>{item.rowCount}</td>
                    <td>{item.rejectedCount}</td>
                    <td>
                      <div className="download-links">
                        <a href={`/api/exports/${item.id}/file`}>
                          <Download size={14} />
                          Catalogue
                        </a>
                        <a href={`/api/exports/${item.id}/report`}>
                          <Download size={14} />
                          Rapport
                        </a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
