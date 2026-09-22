import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
const connectionString = process.env.DATABASE_URL;
if (!connectionString)
  throw new Error(
    "DATABASE_URL manque. Exécutez npm run db:local ou configurez .env.local.",
  );
const globalDb = globalThis as unknown as {
  catamotiveSql?: ReturnType<typeof postgres>;
};
export const sqlClient =
  globalDb.catamotiveSql ??
  postgres(connectionString, { max: 5, idle_timeout: 20, connect_timeout: 10 });
if (process.env.NODE_ENV !== "production") globalDb.catamotiveSql = sqlClient;
export const db = drizzle(sqlClient, { schema });
