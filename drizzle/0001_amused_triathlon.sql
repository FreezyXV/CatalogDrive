CREATE TABLE "account_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "export_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"config" jsonb NOT NULL,
	"storage_key" text NOT NULL,
	"report_key" text NOT NULL,
	"row_count" integer NOT NULL,
	"rejected_count" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "export_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "export_templates_organization_id_name_unique" UNIQUE("organization_id","name")
);
--> statement-breakpoint
CREATE TABLE "mapping_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"headers" jsonb NOT NULL,
	"mapping" jsonb NOT NULL,
	"read_options" jsonb NOT NULL,
	"rules" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mapping_templates_organization_id_name_unique" UNIQUE("organization_id","name")
);
--> statement-breakpoint
CREATE TABLE "processed_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source_line" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"data" jsonb NOT NULL,
	"transformations" jsonb NOT NULL,
	"issues" jsonb NOT NULL,
	"decisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"excluded" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"confidence" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_rows_id_organization_id_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "processed_rows_import_id_run_id_source_line_unique" UNIQUE("import_id","run_id","source_line")
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_records_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "read_options" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "mapping" jsonb;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "rules" jsonb;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "counts" jsonb;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "processed_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "retention_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "exports_import_org_fk" FOREIGN KEY ("import_id","organization_id") REFERENCES "public"."import_jobs"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_templates" ADD CONSTRAINT "export_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mapping_templates" ADD CONSTRAINT "mapping_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed_rows" ADD CONSTRAINT "rows_import_org_fk" FOREIGN KEY ("import_id","organization_id") REFERENCES "public"."import_jobs"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rows_import_status" ON "processed_rows" USING btree ("organization_id","import_id","status");