import {
  pgTable,
  uuid,
  text,
  timestamp,
  primaryKey,
  foreignKey,
  unique,
  jsonb,
  integer,
  index,
} from "drizzle-orm/pg-core";
import type { Diagnostic } from "../../domain/csv";
import type {
  CatalogData,
  Decision,
  Issue,
  Mapping,
  QualityCounts,
  ReadOptions,
  RuleConfig,
  Transformation,
} from "../../domain/catalog";
import type { ExportConfig } from "../../domain/exports";
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const users = pgTable("users", {
  id: uuid().defaultRandom().primaryKey(),
  email: text().notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  createdAt: createdAt(),
});
export const organizations = pgTable("organizations", {
  id: uuid().defaultRandom().primaryKey(),
  name: text().notNull(),
  retentionDays: integer("retention_days").notNull().default(30),
  createdAt: createdAt(),
});
export const memberships = pgTable(
  "memberships",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    role: text().notNull().default("owner"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.organizationId] })],
);
export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.userId, t.organizationId],
      foreignColumns: [memberships.userId, memberships.organizationId],
    }).onDelete("cascade"),
  ],
);
export const sourceArchives = pgTable(
  "source_archives",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    createdBy: uuid("created_by").notNull(),
    originalName: text("original_name").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text().notNull(),
    entryCount: integer("entry_count").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.id, t.organizationId),
    foreignKey({
      columns: [t.createdBy, t.organizationId],
      foreignColumns: [memberships.userId, memberships.organizationId],
    }),
  ],
);
export const importJobs = pgTable(
  "import_jobs",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    createdBy: uuid("created_by").notNull(),
    archiveId: uuid("archive_id"),
    archiveEntry: text("archive_entry"),
    status: text().notNull().default("analyzed"),
    diagnostic: jsonb().$type<Diagnostic>().notNull(),
    readOptions: jsonb("read_options")
      .$type<ReadOptions>()
      .notNull()
      .default({}),
    mapping: jsonb().$type<Mapping>(),
    rules: jsonb().$type<RuleConfig>(),
    counts: jsonb().$type<QualityCounts>(),
    processedCount: integer("processed_count").notNull().default(0),
    attempts: integer().notNull().default(0),
    runId: uuid("run_id"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    error: text(),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.id, t.organizationId),
    index("imports_org_created").on(t.organizationId, t.createdAt),
    foreignKey({
      columns: [t.createdBy, t.organizationId],
      foreignColumns: [memberships.userId, memberships.organizationId],
    }),
    foreignKey({
      columns: [t.archiveId, t.organizationId],
      foreignColumns: [sourceArchives.id, sourceArchives.organizationId],
    }),
  ],
);
export const uploadedFiles = pgTable(
  "uploaded_files",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    importId: uuid("import_id").notNull().unique(),
    originalName: text("original_name").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.importId, t.organizationId],
      foreignColumns: [importJobs.id, importJobs.organizationId],
    }).onDelete("cascade"),
  ],
);
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    userId: uuid("user_id").notNull(),
    action: text().notNull(),
    entityId: uuid("entity_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.userId, t.organizationId],
      foreignColumns: [memberships.userId, memberships.organizationId],
    }),
  ],
);
export const authAttempts = pgTable("auth_attempts", {
  key: text().primaryKey(),
  count: integer().notNull(),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
});

export const mappingTemplates = pgTable(
  "mapping_templates",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text().notNull(),
    headers: jsonb().$type<string[]>().notNull(),
    mapping: jsonb().$type<Mapping>().notNull(),
    readOptions: jsonb("read_options").$type<ReadOptions>().notNull(),
    rules: jsonb().$type<RuleConfig>().notNull(),
    version: integer().notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.organizationId, t.name)],
);
export const processedRows = pgTable(
  "processed_rows",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    importId: uuid("import_id").notNull(),
    runId: uuid("run_id").notNull(),
    sourceLine: integer("source_line").notNull(),
    raw: jsonb().$type<string[]>().notNull(),
    data: jsonb().$type<CatalogData>().notNull(),
    transformations: jsonb().$type<Transformation[]>().notNull(),
    issues: jsonb().$type<Issue[]>().notNull(),
    decisions: jsonb().$type<Decision[]>().notNull().default([]),
    status: text().notNull(),
    excluded: integer().notNull().default(0),
    version: integer().notNull().default(1),
    confidence: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.id, t.organizationId),
    unique().on(t.importId, t.runId, t.sourceLine),
    index("rows_import_status").on(t.organizationId, t.importId, t.status),
    foreignKey({
      name: "rows_import_org_fk",
      columns: [t.importId, t.organizationId],
      foreignColumns: [importJobs.id, importJobs.organizationId],
    }).onDelete("cascade"),
  ],
);
export const exportTemplates = pgTable(
  "export_templates",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text().notNull(),
    config: jsonb().$type<ExportConfig>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.organizationId, t.name)],
);
export const exportJobs = pgTable(
  "export_jobs",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    importId: uuid("import_id").notNull(),
    config: jsonb().$type<ExportConfig>().notNull(),
    storageKey: text("storage_key").notNull(),
    reportKey: text("report_key").notNull(),
    rowCount: integer("row_count").notNull(),
    rejectedCount: integer("rejected_count").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "exports_import_org_fk",
      columns: [t.importId, t.organizationId],
      foreignColumns: [importJobs.id, importJobs.organizationId],
    }).onDelete("cascade"),
  ],
);
export const usageRecords = pgTable("usage_records", {
  id: uuid().defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  kind: text().notNull(),
  amount: integer().notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdAt: createdAt(),
});
export const accountTokens = pgTable("account_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  purpose: text().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
