ALTER TABLE "memberships" ADD COLUMN "managed_by_oidc" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "memberships" AS m
SET "managed_by_oidc" = true
FROM (
  SELECT DISTINCT "user_id", "organization_id"
  FROM "audit_events"
  WHERE "action" IN ('membership.provisioned', 'membership.role_synced')
) AS oidc
WHERE m."user_id" = oidc."user_id"
  AND m."organization_id" = oidc."organization_id";
