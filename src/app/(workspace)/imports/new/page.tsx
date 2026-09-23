import Link from "next/link";
import { ArrowLeft, Check, Download, Info, LockKeyhole } from "lucide-react";
import { UploadForm } from "@/components/upload-form";
export default function NewImport() {
  return (
    <>
      <Link href="/dashboard" className="back-link">
        <ArrowLeft size={15} />
        Vue d’ensemble
      </Link>
      <div className="page-heading">
        <div>
          <span className="eyebrow">01 / IMPORTER LA SOURCE</span>
          <h1>Nouvel import</h1>
          <p>Commençons par comprendre votre fichier fournisseur.</p>
        </div>
        <span className="status-badge neutral">
          <LockKeyhole size={14} />
          Import privé
        </span>
      </div>
      <div className="import-layout">
        <section className="panel upload-panel">
          <div className="panel-heading">
            <div>
              <h2>Fichier fournisseur</h2>
              <p>Vos données originales restent intactes.</p>
            </div>
            <span className="format-tag">.CSV · .XLSX · .ZIP</span>
          </div>
          <UploadForm />
        </section>
        <aside className="import-aside">
          <section className="panel guidance">
            <span className="eyebrow">CE QUE NOUS ANALYSONS</span>
            <h2>
              Un premier regard
              <br />
              sur vos données.
            </h2>
            <ul>
              {[
                "Encodage, séparateur et feuille",
                "En-têtes et nombre de colonnes",
                "Nombre de lignes du fichier",
                "Aperçu des 20 premières lignes",
                "Écarts dans la structure",
              ].map((text) => (
                <li key={text}>
                  <Check size={16} />
                  {text}
                </li>
              ))}
            </ul>
            <div className="guidance-info">
              <Info size={17} />
              <p>
                La ligne d’en-tête et la feuille peuvent être ajustées à l’étape
                suivante. Les formules Excel ne sont jamais exécutées.
              </p>
            </div>
          </section>
          <section className="demo-card">
            <span className="format-tag">ESSAYER AVEC UN EXEMPLE</span>
            <h3>Pas de fichier sous la main ?</h3>
            <p>
              Un petit CSV fictif pour découvrir le parcours, sans donnée
              client.
            </p>
            <a href="/demo/fournisseur-demo.csv" download>
              <Download size={16} />
              Télécharger le CSV démo
            </a>
          </section>
        </aside>
      </div>
      <div className="footnote">
        <Info size={15} />
        UTF-8, UTF-16LE avec BOM et Windows-1252 sont pris en charge. Les
        classeurs chiffrés, macros et contenus externes sont refusés. Un ZIP
        crée un import distinct pour chaque CSV ou XLSX qu’il contient.
      </div>
    </>
  );
}
