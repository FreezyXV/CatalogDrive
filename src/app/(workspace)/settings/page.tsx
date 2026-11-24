import { requirePageIdentity } from "@/server/auth";
import { organizationSummary } from "@/server/organization";
import { OrganizationForm } from "@/components/organization-form";
import { BillingPanel } from "@/components/billing-panel";
import { billingOverview } from "@/server/billing/quotas";
import { billingEnabled } from "@/server/billing/config";
import { can } from "@/server/auth/rbac";
const NOTICES: Record<string, string> = {
  success:
    "Paiement reçu. L’offre s’active dès la confirmation de Stripe, en général en quelques secondes : rechargez la page si besoin.",
  cancel: "Paiement annulé. Aucun montant n’a été débité.",
};
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ billing?: string; plan?: string }>;
}) {
  const actor = await requirePageIdentity();
  const query = await searchParams;
  const [data, billing] = await Promise.all([
    organizationSummary(actor),
    billingOverview(actor.organizationId),
  ]);
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">PARAMÈTRES</span>
          <h1>Organisation et confidentialité</h1>
          <p>
            Gérez votre abonnement, la conservation et suivez l’usage du mois.
          </p>
        </div>
      </div>
      <BillingPanel
        planId={billing.plan.id}
        status={billing.status}
        currentPeriodEnd={billing.currentPeriodEnd?.toISOString() ?? null}
        cancelAtPeriodEnd={billing.cancelAtPeriodEnd}
        hasCustomer={billing.hasCustomer}
        usage={billing.usage}
        enforced={billing.enforced}
        billingEnabled={billingEnabled()}
        canManage={can(actor.role, "organization:manage")}
        highlight={query.plan}
        notice={query.billing ? NOTICES[query.billing] : undefined}
      />
      <OrganizationForm
        name={data.organization.name}
        retention={data.organization.retentionDays}
        maxRetention={
          billing.enforced ? billing.plan.quotas.maxRetentionDays : undefined
        }
      />
    </>
  );
}
