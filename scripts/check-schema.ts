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
const [{ count }] = await sqlClient<{ count: number }[]>`
  select count(*)::int as count from information_schema.columns
  where table_name = 'users' and column_name = 'oidc_subject'`;
await sqlClient.end();
if (missing.length || !count) {
  console.error(
    `Schéma incomplet : ${[...missing, ...(count ? [] : ["users.oidc_subject"])].join(", ")}`,
  );
  process.exit(1);
}
console.log("Schéma conforme.");
