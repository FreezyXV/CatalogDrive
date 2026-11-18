/** Fails if the migrated database lacks a table the application needs. */
export {};
const { sqlClient } = await import("../src/server/db/index");
const rows = await sqlClient<{ table_name: string }[]>`
  select table_name from information_schema.tables
  where table_schema = 'public' order by 1`;
const names = rows.map((r) => r.table_name);
console.log(`${names.length} tables : ${names.join(", ")}`);
const required = [
  "users",
  "organizations",
  "memberships",
  "sessions",
  "import_jobs",
  "processed_rows",
  "outbox_messages",
  "export_requests",
];
const missing = required.filter((t) => !names.includes(t));
const columns = await sqlClient<{ name: string }[]>`
  select table_name || '.' || column_name as name
  from information_schema.columns
  where table_schema = 'public' and table_name in ('users', 'memberships')`;
const requiredColumns = ["users.oidc_subject", "memberships.managed_by_oidc"];
const missingColumns = requiredColumns.filter(
  (name) => !columns.some((column) => column.name === name),
);
await sqlClient.end();
if (missing.length || missingColumns.length) {
  console.error(
    `Schéma incomplet : ${[...missing, ...missingColumns].join(", ")}`,
  );
  process.exit(1);
}
console.log("Schéma conforme.");
