/**
 * Normalises a PostgreSQL URL for postgres.js and detects transaction poolers.
 *
 * - `channel_binding` (added by Neon to its connection strings) is a libpq
 *   option that postgres.js does not implement: left in the URL it would be
 *   sent to the server as a run-time parameter and the connection refused.
 * - `sslmode=require` makes postgres.js skip certificate verification; for a
 *   remote host we upgrade it to `verify-full` (hostname + CA checked).
 * - A transaction pooler (PgBouncer: Supabase port 6543, Neon `-pooler` host)
 *   does not keep prepared statements between transactions, so they are
 *   disabled for it.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function normalizeDatabaseUrl(raw: string) {
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  if (
    url.searchParams.get("sslmode") === "require" &&
    !LOCAL_HOSTS.has(url.hostname)
  )
    url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

export function isTransactionPooler(raw: string) {
  const url = new URL(raw);
  return url.port === "6543" || url.hostname.includes("-pooler.");
}
