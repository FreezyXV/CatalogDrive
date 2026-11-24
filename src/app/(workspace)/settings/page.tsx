import { requirePageIdentity } from "@/server/auth";
import { organizationSummary } from "@/server/organization";
import { OrganizationForm } from "@/components/organization-form";
import { StoreConnections } from "@/components/store-connections";
import { listConnections } from "@/server/stores/connections";
import { can } from "@/server/auth/rbac";
export default async function SettingsPage() {
  const actor = await requirePageIdentity();
  const [data, connections] = await Promise.all([
    organizationSummary(actor),
    listConnections(actor),
  ]);
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">PARAMÈTRES</span>
          <h1>Organisation et confidentialité</h1>
          <p>Gérez la conservation et consultez l’usage réel de CataMotive.</p>
        </div>
      </div>
      <section className="stats-grid">
        <div className="stat">
          <span>Lignes traitées</span>
          <strong>{data.usage.rows.toLocaleString("fr-FR")}</strong>
          <small>Mesure persistante des traitements</small>
        </div>
        <div className="stat">
          <span>Exports créés</span>
          <strong>{data.usage.exports}</strong>
          <small>Catalogues générés</small>
        </div>
        <div className="stat">
          <span>Stockage source</span>
          <strong>
            {(data.storageBytes / 1024 / 1024).toLocaleString("fr-FR", {
              maximumFractionDigits: 2,
            })}
            <em>Mio</em>
          </strong>
          <small>Fichiers actuellement conservés</small>
        </div>
      </section>
      <OrganizationForm
        name={data.organization.name}
        retention={data.organization.retentionDays}
      />
      <StoreConnections
        connections={connections}
        canManage={can(actor.role, "store:manage")}
      />
    </>
  );
}
