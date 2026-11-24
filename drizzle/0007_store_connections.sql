CREATE TABLE "store_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"label" text NOT NULL,
	"address" text NOT NULL,
	"credentials" text NOT NULL,
	"secret_hint" text NOT NULL,
	"store_name" text,
	"currency" text,
	"prices_include_tax" boolean,
	"checked_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_connections_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "store_connections_organization_id_platform_address_unique" UNIQUE("organization_id","platform","address")
);
--> statement-breakpoint
CREATE TABLE "store_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"update_mode" text NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"counts" jsonb DEFAULT '{"created":0,"updated":0,"skipped":0,"failed":0}'::jsonb NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"run_id" uuid,
	"heartbeat_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "store_connections" ADD CONSTRAINT "store_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_syncs" ADD CONSTRAINT "store_syncs_import_org_fk" FOREIGN KEY ("import_id","organization_id") REFERENCES "public"."import_jobs"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_syncs" ADD CONSTRAINT "store_syncs_connection_org_fk" FOREIGN KEY ("connection_id","organization_id") REFERENCES "public"."store_connections"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_syncs" ADD CONSTRAINT "store_syncs_member_fk" FOREIGN KEY ("requested_by","organization_id") REFERENCES "public"."memberships"("user_id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "store_syncs_org_import" ON "store_syncs" USING btree ("organization_id","import_id");--> statement-breakpoint
CREATE INDEX "store_syncs_pending" ON "store_syncs" USING btree ("status","heartbeat_at");