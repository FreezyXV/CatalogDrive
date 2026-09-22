import { requirePageIdentity } from "@/server/auth";
import { listMappingTemplates } from "@/server/catalog";
import { listExportTemplates } from "@/server/exports";
import { PROFILES } from "@/domain/exports";
export default async function TemplatesPage() {
  const actor = await requirePageIdentity();
  const [mapping, exports] = await Promise.all([
    listMappingTemplates(actor),
    listExportTemplates(actor),
  ]);
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">AUTOMATISER LES RÉCURRENCES</span>
          <h1>Modèles enregistrés</h1>
          <p>
            Réutilisez les correspondances fournisseurs et vos formats de
            sortie.
          </p>
        </div>
      </div>
      <div className="detail-bottom">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Modèles fournisseurs</h2>
              <p>Disponibles depuis l’écran de mapping.</p>
            </div>
            <span className="count-badge">{mapping.length}</span>
          </div>
          {mapping.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Nom</th>
                    <th>Champs</th>
                    <th>Version</th>
                  </tr>
                </thead>
                <tbody>
                  {mapping.map((item) => (
                    <tr key={item.id}>
                      <td>{item.name}</td>
                      <td>{Object.keys(item.mapping).length}</td>
                      <td>{item.version}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">
              <p>Enregistrez un mapping pour le retrouver ici.</p>
            </div>
          )}
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Modèles d’export</h2>
              <p>Configurations sauvegardées lors d’un export.</p>
            </div>
            <span className="count-badge">{exports.length}</span>
          </div>
          {exports.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Nom</th>
                    <th>Profil</th>
                    <th>Colonnes</th>
                  </tr>
                </thead>
                <tbody>
                  {exports.map((item) => (
                    <tr key={item.id}>
                      <td>{item.name}</td>
                      <td>{PROFILES[item.config.profile]}</td>
                      <td>{item.config.columns.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">
              <p>Enregistrez une configuration depuis l’écran d’export.</p>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
