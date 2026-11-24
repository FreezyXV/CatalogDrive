"use client";
import { useState } from "react";
import { Check, CreditCard, ExternalLink } from "lucide-react";
import {
  PAID_PLAN_IDS,
  PLANS,
  formatBytes,
  formatQuota,
  quotaLines,
  type PaidPlanId,
  type PlanId,
} from "@/domain/plans";

type Props = {
  planId: PlanId;
  status: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  hasCustomer: boolean;
  usage: { rows: number; exports: number; storageBytes: number };
  enforced: boolean;
  billingEnabled: boolean;
  canManage: boolean;
  highlight?: string;
  notice?: string;
};

const STATUS_LABELS: Record<string, string> = {
  active: "Actif",
  trialing: "Période d’essai",
  past_due: "Paiement en retard",
  unpaid: "Impayé",
  canceled: "Résilié",
  incomplete: "Paiement à finaliser",
  incomplete_expired: "Paiement expiré",
  paused: "Suspendu",
  manual: "Facturation manuelle",
};

function Meter({
  label,
  used,
  limit,
  format,
  period = true,
}: {
  label: string;
  used: number;
  limit: number | null;
  format: (value: number) => string;
  period?: boolean;
}) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{format(used)}</strong>
      {limit !== null && (
        <progress
          className="upload-progress"
          value={Math.min(used, limit)}
          max={limit}
          aria-label={`${label} : ${format(used)} sur ${format(limit)}`}
        />
      )}
      <small>
        {limit === null
          ? "Illimité"
          : `sur ${format(limit)}${period ? " ce mois-ci" : ""}`}
      </small>
    </div>
  );
}

export function BillingPanel(props: Props) {
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const plan = PLANS[props.planId];

  async function go(path: string, body?: object) {
    setPending(path + JSON.stringify(body ?? {}));
    setError("");
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const data = await response.json();
      if (!response.ok || !data.url) throw new Error(data.error);
      window.location.assign(data.url);
    } catch (cause) {
      setError(
        (cause as Error).message || "Le service de paiement est indisponible.",
      );
      setPending("");
    }
  }

  return (
    <section className="panel form-panel" id="abonnement">
      <div className="panel-heading">
        <div>
          <h2>Abonnement : offre {plan.name}</h2>
          <p>
            {props.status
              ? `Statut : ${STATUS_LABELS[props.status] ?? props.status}.`
              : "Aucun abonnement payant."}
            {props.currentPeriodEnd &&
              ` ${props.cancelAtPeriodEnd ? "Se termine" : "Renouvellement"} le ${new Date(props.currentPeriodEnd).toLocaleDateString("fr-FR")}.`}
            {!props.enforced &&
              " Pilote : les quotas ne sont pas encore appliqués."}
          </p>
        </div>
        {props.hasCustomer && props.billingEnabled && props.canManage && (
          <button
            className="button secondary"
            disabled={Boolean(pending)}
            onClick={() => go("/api/billing/portal")}
          >
            <ExternalLink size={16} />
            Factures et moyen de paiement
          </button>
        )}
      </div>
      <div className="form-section billing-section">
        {props.notice && (
          <p className="alert info" role="status">
            {props.notice}
          </p>
        )}
        {props.status === "past_due" && (
          <p className="alert error" role="alert">
            Le dernier paiement a échoué. Mettez à jour votre moyen de paiement
            pour conserver l’offre {plan.name}.
          </p>
        )}
        <div className="stats-grid">
          <Meter
            label="Lignes traitées"
            used={props.usage.rows}
            limit={plan.quotas.monthlyRows}
            format={(value) => formatQuota(value)}
          />
          <Meter
            label="Exports"
            used={props.usage.exports}
            limit={plan.quotas.monthlyExports}
            format={(value) => formatQuota(value)}
          />
          <Meter
            label="Fichiers conservés"
            used={props.usage.storageBytes}
            limit={plan.quotas.storageBytes}
            format={formatBytes}
            period={false}
          />
        </div>
        <div className="pricing-grid">
          {PAID_PLAN_IDS.map((id: PaidPlanId) => {
            const offer = PLANS[id];
            const current = id === props.planId;
            return (
              <article
                key={id}
                className={`panel pricing-card ${current || id === props.highlight ? "featured" : ""}`}
              >
                <span className="format-tag">{offer.name.toUpperCase()}</span>
                <strong>
                  {offer.price} €<small> HT / mois</small>
                </strong>
                <ul>
                  {quotaLines(offer.quotas).map((line) => (
                    <li key={line}>
                      <Check size={15} />
                      {line}
                    </li>
                  ))}
                </ul>
                <button
                  className="button primary"
                  disabled={
                    current ||
                    !props.billingEnabled ||
                    !props.canManage ||
                    Boolean(pending)
                  }
                  onClick={() => go("/api/billing/checkout", { plan: id })}
                >
                  <CreditCard size={16} />
                  {current
                    ? "Offre actuelle"
                    : props.planId === "essai"
                      ? "Souscrire"
                      : "Changer d’offre"}
                </button>
              </article>
            );
          })}
        </div>
        <p className="fine-print">
          {!props.billingEnabled
            ? "Le paiement en ligne n’est pas encore activé."
            : !props.canManage
              ? "Seul un administrateur peut gérer l’abonnement."
              : "Paiement sécurisé par Stripe. Résiliable à tout moment depuis le portail ; l’offre reste active jusqu’à la fin de la période payée."}
        </p>
        {error && (
          <p className="alert error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
