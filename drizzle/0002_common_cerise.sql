CREATE TABLE "source_archives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"original_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"entry_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_archives_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "source_archives_id_organization_id_unique" UNIQUE("id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "archive_id" uuid;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "archive_entry" text;--> statement-breakpoint
ALTER TABLE "source_archives" ADD CONSTRAINT "source_archives_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_archives" ADD CONSTRAINT "source_archives_created_by_organization_id_memberships_user_id_organization_id_fk" FOREIGN KEY ("created_by","organization_id") REFERENCES "public"."memberships"("user_id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_archive_id_organization_id_source_archives_id_organization_id_fk" FOREIGN KEY ("archive_id","organization_id") REFERENCES "public"."source_archives"("id","organization_id") ON DELETE no action ON UPDATE no action;