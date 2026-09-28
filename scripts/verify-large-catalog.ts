import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { parse } from "csv-parse";
import { eq } from "drizzle-orm";
config({ path: ".env.test", override: true, quiet: true });
if (!process.env.DATABASE_URL?.endsWith("/catamotive_test"))
  throw new Error("Cet essai exige la base locale dédiée catamotive_test.");
const root = await mkdtemp(join(tmpdir(), "catalogue-500000-"));
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = root;
const { db, sqlClient } = await import("../src/server/db");
const schema = await import("../src/server/db/schema");
const { registerAccount } = await import("../src/server/auth");
const { importCsv, removeImport } = await import("../src/server/imports");
const { queueImport, runJob, saveMapping, qualityRows } =
  await import("../src/server/catalog");
const { createExport } = await import("../src/server/exports");
const { getFileStore } = await import("../src/server/storage");
const { DEFAULT_RULES } = await import("../src/domain/catalog");
const { defaultExportConfig } = await import("../src/domain/exports");
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
await migrate(db, { migrationsFolder: "drizzle" });
const actor = await registerAccount(
  `large-${randomUUID()}@example.test`,
  randomUUID(),
  "Essai local 500000 lignes",
);
const started = Date.now();
const log = (step: string, extra = {}) =>
  console.log(
    JSON.stringify({
      step,
      seconds: Math.round((Date.now() - started) / 1000),
      ...extra,
    }),
  );
let id: string | undefined;
try {
  async function* input() {
    yield Buffer.from("sku\tnom\tdevise\n");
    for (let i = 0; i < 500_000; i++)
      yield Buffer.from(`R${String(i).padStart(6, "0")}\tPièce\tEUR\n`);
  }
  id = await importCsv(
    actor,
    "catalogue-500000.tsv",
    Readable.toWeb(Readable.from(input())) as ReadableStream<Uint8Array>,
  );
  log("diagnostic");
  await saveMapping(
    actor,
    id,
    { sku: 0, product_name: 1, currency: 2 },
    { ...DEFAULT_RULES, fuzzyDuplicates: false },
    {},
  );
  await queueImport(actor, id);
  await runJob(id);
  const quality = await qualityRows(actor, id, undefined, 10_000);
  if (
    quality.job.counts?.valid !== 500_000 ||
    quality.rows.length !== 50 ||
    quality.rows.at(-1)?.sourceLine !== 500_001
  )
    throw new Error(
      "Les lignes traitées ou la dernière page sont incomplètes.",
    );
  log("traitement-et-pagination", { rows: quality.job.counts.total });
  const exported = await createExport(
    actor,
    id,
    defaultExportConfig("generic"),
  );
  let count = 0;
  let lastSku = "";
  for await (const row of getFileStore()
    .read(exported.storageKey)
    .pipe(parse({ columns: true, bom: true, delimiter: ";" }))) {
    if (!count && row.sku !== "R000000")
      throw new Error("Première référence incorrecte.");
    count++;
    lastSku = row.sku;
  }
  if (count !== 500_000 || exported.rowCount !== count || lastSku !== "R499999")
    throw new Error("Le CSV téléchargé est incomplet.");
  const [size] =
    await sqlClient`select pg_database_size(current_database()) as database_bytes`;
  log("export-verifie", { rows: count, databaseBytes: size.database_bytes });
} finally {
  try {
    if (id) await removeImport(actor, id);
    await db
      .delete(schema.sessions)
      .where(eq(schema.sessions.userId, actor.userId));
    for (const table of [
      schema.auditEvents,
      schema.mappingTemplates,
      schema.usageRecords,
    ])
      await db
        .delete(table)
        .where(eq(table.organizationId, actor.organizationId));
    await db
      .delete(schema.accountTokens)
      .where(eq(schema.accountTokens.userId, actor.userId));
    await db
      .delete(schema.memberships)
      .where(eq(schema.memberships.userId, actor.userId));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, actor.organizationId));
    await db.delete(schema.users).where(eq(schema.users.id, actor.userId));
  } finally {
    await sqlClient.end();
    await rm(root, { recursive: true, force: true });
  }
}
