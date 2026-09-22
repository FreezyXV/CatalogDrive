import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requirePageIdentity } from "@/server/auth";
import { getImport } from "@/server/imports";
import { listMappingTemplates } from "@/server/catalog";
import { HttpError } from "@/server/http";
import { MappingForm } from "@/components/mapping-form";
export default async function MappingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requirePageIdentity();
  const { id } = await params;
  const { job, file } = await getImport(actor, id).catch((error) => {
    if (error instanceof HttpError && error.status === 404) notFound();
    throw error;
  });
  const templates = await listMappingTemplates(actor);
  return (
    <>
      <Link href={`/imports/${id}`} className="back-link">
        <ArrowLeft size={15} />
        Diagnostic
      </Link>
      <div className="page-heading">
        <div>
          <span className="eyebrow">03 / MAPPER LE CATALOGUE</span>
          <h1>Correspondance des colonnes</h1>
          <p>
            {file.originalName} · {job.diagnostic.headers.length} colonnes
            détectées
          </p>
        </div>
      </div>
      <MappingForm
        id={id}
        initial={job.diagnostic}
        initialMapping={job.mapping}
        initialOptions={job.readOptions}
        initialRules={job.rules}
        templates={templates}
      />
    </>
  );
}
