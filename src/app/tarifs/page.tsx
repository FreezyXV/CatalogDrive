import Link from "next/link";
import { Check, ArrowRight } from "lucide-react";
import { IMPORT_FORMAT_LABEL } from "@/domain/import-formats";
import { Brand } from "@/components/brand";
import { PLAN_IDS, PLANS, quotaLines } from "@/domain/plans";
import { billingEnabled } from "@/server/billing/config";
const plans = PLAN_IDS.map((id) => PLANS[id]);
export default function PricingPage() {
  const payable = billingEnabled();
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
          {payable
            ? "Prix hors taxes, sans engagement. Créez votre espace puis souscrivez depuis Paramètres ; le paiement est sécurisé par Stripe."
            : "Les paiements ne sont pas encore activés. Les offres servent de cadre au pilote et n’entraînent aucun débit."}
        </p>
        <div className="pricing-grid">
          {plans.map((plan) => (
            <article
              className={`panel pricing-card ${plan.name === "Starter" ? "featured" : ""}`}
              key={plan.id}
            >
              <span className="format-tag">{plan.name.toUpperCase()}</span>
              <strong>
                {plan.price} €<small> HT / mois</small>
              </strong>
              <p>{plan.text}</p>
              <ul>
                {[
                  ...(plan.id === "essai" ? [IMPORT_FORMAT_LABEL] : []),
                  ...plan.features,
                  ...quotaLines(plan.quotas),
                ].map((feature) => (
                  <li key={feature}>
                    <Check size={15} />
                    {feature}
                  </li>
                ))}
              </ul>
              <Link
                href={
                  plan.id === "essai" || !payable
                    ? "/inscription"
                    : `/settings?plan=${plan.id}#abonnement`
                }
                className="button primary"
              >
                {plan.id === "essai" || !payable
                  ? "Créer mon espace"
                  : `Choisir ${plan.name}`}
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
