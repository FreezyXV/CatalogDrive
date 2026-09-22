import { config } from "dotenv";
config({
  path: process.env.APP_ENV === "test" ? ".env.test" : ".env.local",
  quiet: true,
});
const { db, sqlClient } = await import("../src/server/db/index");
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
await migrate(db, { migrationsFolder: "drizzle" });
await sqlClient.end();
console.log("Migrations PostgreSQL appliquées.");
