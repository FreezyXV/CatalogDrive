import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
import { isTransactionPooler, normalizeDatabaseUrl } from "./connection";
// Migrations prefer the direct (unpooled) URL when one is provided.
const configured =
  (process.env.DB_MIGRATING === "1" && process.env.DATABASE_URL_UNPOOLED) ||
  process.env.DATABASE_URL;
if (!configured)
  throw new Error(
    "DATABASE_URL manque. Exécutez npm run db:local ou configurez .env.local.",
  );
const connectionString = normalizeDatabaseUrl(configured);
const transactionPool = isTransactionPooler(connectionString);
const serverless = Boolean(process.env.VERCEL);
const globalDb = globalThis as unknown as {
  catamotiveSql?: ReturnType<typeof postgres>;
};
export const sqlClient =
  globalDb.catamotiveSql ??
  postgres(connectionString, {
    max: serverless || transactionPool ? 1 : 5,
    prepare: !transactionPool,
    ...(transactionPool ? { max_pipeline: 1 } : {}),
    idle_timeout: 20,
    connect_timeout: 10,
  });
if (process.env.NODE_ENV !== "production") globalDb.catamotiveSql = sqlClient;
export const db = drizzle(sqlClient, { schema });

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function lockTransaction(tx: Transaction, key: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}
