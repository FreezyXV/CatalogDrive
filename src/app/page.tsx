import Link from "next/link";
import { ArrowRight, FileSearch, FolderLock, ScanLine } from "lucide-react";
import { Brand } from "@/components/brand";
export default function Home() {
  return (
    <div className="landing">
      <header className="landing-header">
        <Brand />
        <div className="landing-nav">
          <Link href="/tarifs">Tarifs</Link>
          <Link href="/connexion" className="button secondary">
            Se connecter
            <ArrowRight size={16} />
          </Link>
        </div>
      </header>
      <main className="landing-main">
        <span className="eyebrow">L’ATELIER DE VOS DONNÉES CATALOGUE</span>
        <h1>
          De bons catalogues
          <br />
          commencent par
          <br />
          <em>des données claires.</em>
        </h1>
        <p>
          Transformez vos CSV et XLSX fournisseurs en catalogues propres,
          contrôlés et prêts pour WooCommerce, PrestaShop ou Shopify.
        </p>
        <div className="landing-actions">
          <Link href="/inscription" className="button primary">
            Créer mon espace
            <ArrowRight size={18} />
          </Link>
          <span>Essai sans paiement · Données privées</span>
        </div>
        <div className="landing-features">
          <div>
            <ScanLine />
            <h2>Inspectez la source</h2>
            <p>Colonnes, feuille, encodage, séparateur et mapping proposé.</p>
          </div>
          <div>
            <FolderLock />
            <h2>Gardez vos originaux</h2>
            <p>Un stockage privé et des données toujours intactes.</p>
          </div>
          <div>
            <FileSearch />
            <h2>Retrouvez chaque import</h2>
            <p>Chaque correction et chaque règle restent explicables.</p>
          </div>
        </div>
        <p className="pilot-note">
          CataMotive ne déduit aucune compatibilité véhicule/pièce et conserve
          les informations automobiles brutes lorsqu’aucune source fiable ne les
          confirme.
        </p>
      </main>
    </div>
  );
}
