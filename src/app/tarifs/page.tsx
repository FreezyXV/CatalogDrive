import Link from "next/link";
import { Check, ArrowRight } from "lucide-react";
import { Brand } from "@/components/brand";
const plans = [
  {
    name: "Essai",
    price: "0 €",
    text: "Découvrir le parcours avec un petit catalogue.",
    features: ["Compte et organisation", "CSV et XLSX", "Export générique"],
  },
  {
    name: "Starter",
    price: "59 €",
    text: "Pour un revendeur indépendant.",
    features: ["Imports récurrents", "Profils CMS", "Modèles fournisseurs"],
  },
  {
    name: "Pro",
    price: "199 €",
    text: "Pour une équipe catalogue active.",
    features: [
      "Volumes supérieurs",
      "Historique complet",
      "Support prioritaire",
    ],
  },
  {
    name: "Business",
    price: "499 €",
    text: "Pour plusieurs catalogues ou clients.",
    features: ["Usage étendu", "Gouvernance renforcée", "Accompagnement"],
  },
];
export default function PricingPage() {
  return (
    <div className="landing">
      <header className="landing-header">
        <Link href="/">
          <Brand />
        </Link>
        <Link href="/connexion" className="button secondary">
          Se connecter
          <ArrowRight size={16} />
        </Link>
      </header>
      <main className="pricing-main">
        <span className="eyebrow">DES OFFRES LISIBLES</span>
        <h1>Le temps catalogue redevient du temps métier.</h1>
        <p>
          Les paiements ne sont pas encore activés. Les offres servent de cadre
          au pilote et n’entraînent aucun débit.
        </p>
        <div className="pricing-grid">
          {plans.map((plan) => (
            <article
              className={`panel pricing-card ${plan.name === "Starter" ? "featured" : ""}`}
              key={plan.name}
            >
              <span className="format-tag">{plan.name.toUpperCase()}</span>
              <strong>
                {plan.price}
                <small>/ mois</small>
              </strong>
              <p>{plan.text}</p>
              <ul>
                {plan.features.map((feature) => (
                  <li key={feature}>
                    <Check size={15} />
                    {feature}
                  </li>
                ))}
              </ul>
              <Link href="/inscription" className="button primary">
                Créer mon espace
              </Link>
            </article>
          ))}
        </div>
        <section className="one-off">
          <h2>Traitement ponctuel</h2>
          <p>
            Pour un catalogue exceptionnel ou un accompagnement : de 199 € à 999
            € selon le volume et la complexité.
          </p>
        </section>
      </main>
    </div>
  );
}
