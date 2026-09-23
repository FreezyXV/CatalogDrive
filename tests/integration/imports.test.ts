import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import yazl from "yazl";
import ExcelJS from "exceljs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../../src/server/db";
import {
  auditEvents,
  authAttempts,
  importJobs,
  mappingTemplates,
  exportTemplates,
  usageRecords,
  accountTokens,
  memberships,
  organizations,
  sessions,
  sourceArchives,
  uploadedFiles,
  users,
} from "../../src/server/db/schema";
import {
  authenticate,
  limitAuth,
  limitAuthNetwork,
  networkAttemptKey,
  registerAccount,
} from "../../src/server/auth";
import {
  getImport,
  importCsv,
  importZip,
  importSignedArchive,
  getSourceArchiveForImport,
  listImports,
  removeImport,
} from "../../src/server/imports";
import { LocalFileStore } from "../../src/server/storage";
import { hashToken } from "../../src/server/auth/password";
import { DEFAULT_RULES } from "../../src/domain/catalog";
import { defaultExportConfig } from "../../src/domain/exports";
import {
  listMappingTemplates,
  qualityRows,
  queueImport,
  runJob,
  saveMapping,
} from "../../src/server/catalog";
import { createExport, getExport } from "../../src/server/exports";

if (!process.env.DATABASE_URL?.endsWith("/catamotive_test"))
  throw new Error(
    "Les tests d’intégration exigent la base dédiée catamotive_test (.env.test).",
  );
const suffix = randomUUID();
const password = "mot-de-passe-test-uniquement";
const emailA = `a-${suffix}@example.test`;
const emailB = `b-${suffix}@example.test`;
let actorA: { userId: string; organizationId: string };
let actorB: { userId: string; organizationId: string };
let store: LocalFileStore;
let root: string;
const csv = () => new Blob(["ref;nom\n001;Pièce fictive\n"]).stream();
beforeAll(async () => {
  await migrate(db, { migrationsFolder: "drizzle" });
  root = await mkdtemp(join(tmpdir(), "catamotive-integration-"));
  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_DIR = root;
  store = new LocalFileStore(root);
  actorA = await registerAccount(emailA, password, "Organisation A");
  actorB = await registerAccount(emailB, password, "Organisation B");
});
afterAll(async () => {
  for (const actor of [actorA, actorB].filter(Boolean)) {
    await db.delete(sessions).where(eq(sessions.userId, actor.userId));
    await db
      .delete(auditEvents)
      .where(eq(auditEvents.organizationId, actor.organizationId));
    await db
      .delete(importJobs)
      .where(eq(importJobs.organizationId, actor.organizationId));
    await db
      .delete(sourceArchives)
      .where(eq(sourceArchives.organizationId, actor.organizationId));
    await db
      .delete(mappingTemplates)
      .where(eq(mappingTemplates.organizationId, actor.organizationId));
    await db
      .delete(exportTemplates)
      .where(eq(exportTemplates.organizationId, actor.organizationId));
    await db
      .delete(usageRecords)
      .where(eq(usageRecords.organizationId, actor.organizationId));
    await db
      .delete(accountTokens)
      .where(eq(accountTokens.userId, actor.userId));
    await db.delete(memberships).where(eq(memberships.userId, actor.userId));
    await db
      .delete(organizations)
      .where(eq(organizations.id, actor.organizationId));
    await db.delete(users).where(eq(users.id, actor.userId));
  }
  await db.delete(authAttempts).where(eq(authAttempts.key, hashToken(emailA)));
  if (root) await rm(root, { recursive: true, force: true });
  await sqlClient.end();
});
describe("compte et import sur PostgreSQL réel", () => {
  it("authentifie et refuse un mauvais mot de passe", async () => {
    expect(await authenticate(emailA, password)).toEqual(actorA);
    await expect(
      authenticate(emailA, "mauvais mot de passe"),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("plafonne les inscriptions par réseau fiable, même avec des emails différents", async () => {
    const previous = process.env.VERCEL;
    process.env.VERCEL = "1";
    const ip = `2001:db8:${suffix.slice(0, 4)}::1`;
    const request = new Request("https://catalog-drive.vercel.app/", {
      headers: { "x-vercel-forwarded-for": ip },
    });
    const other = new Request("https://catalog-drive.vercel.app/", {
      headers: {
        "x-vercel-forwarded-for": `2001:db8:${suffix.slice(4, 8)}::1`,
      },
    });
    const keys = [
      networkAttemptKey(request, "register"),
      networkAttemptKey(other, "register"),
    ];
    try {
      for (let index = 0; index < 10; index++)
        await limitAuthNetwork(request, "register");
      await expect(limitAuthNetwork(request, "register")).rejects.toMatchObject(
        {
          status: 429,
        },
      );
      await expect(
        limitAuthNetwork(other, "register"),
      ).resolves.toBeUndefined();
    } finally {
      for (const key of keys)
        if (key) await db.delete(authAttempts).where(eq(authAttempts.key, key));
      if (previous === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = previous;
    }
  });
  it("ne crée pas d'organisation orpheline pour une adresse existante", async () => {
    const attemptedName = `Doublon-${suffix}`;
    await expect(
      registerAccount(emailA, password, attemptedName),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await db
        .select()
        .from(organizations)
        .where(eq(organizations.name, attemptedName)),
    ).toHaveLength(0);
  });
  it("persiste le diagnostic et isole lectures, listes et suppressions", async () => {
    const id = await importCsv(actorA, "catalogue.csv", csv(), store);
    expect(
      (await getImport(actorA, id)).job.diagnostic.preview[0].values[0],
    ).toBe("001");
    expect((await listImports(actorA)).map(({ job }) => job.id)).toContain(id);
    expect(await listImports(actorB)).toHaveLength(0);
    await expect(getImport(actorB, id)).rejects.toMatchObject({ status: 404 });
    await expect(removeImport(actorB, id, store)).rejects.toMatchObject({
      status: 404,
    });
    await expect(getImport(actorA, "../../secret")).rejects.toMatchObject({
      status: 404,
    });
    const imported = await getImport(actorA, id);
    await removeImport(actorA, id, store);
    await expect(getImport(actorA, id)).rejects.toMatchObject({ status: 404 });
    await expect(store.sample(imported.file.storageKey)).rejects.toThrow();
    const audit = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, id));
    expect(audit.map((event) => event.action)).toEqual([
      "import.created",
      "import.deleted",
    ]);
  });
  it("importe un ZIP CSV/XLSX en deux catalogues et préserve l’archive jusqu’au dernier retrait", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Catalogue");
    sheet.addRow(["ref", "nom"]);
    sheet.addRow(["X-002", "Pièce XLSX"]);
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from("ref;nom\nC-001;Pièce CSV\n"), "a/catalogue.csv");
    zip.addBuffer(
      Buffer.from(await workbook.xlsx.writeBuffer()),
      "b/catalogue.xlsx",
    );
    zip.end();
    const chunks: Buffer[] = [];
    for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
    const original = Buffer.concat(chunks);
    const ids = await importZip(
      actorA,
      "fournisseurs.zip",
      new Blob([new Uint8Array(original)]).stream(),
      store,
    );
    expect(ids).toHaveLength(2);
    const first = await getImport(actorA, ids[0]);
    const second = await getImport(actorA, ids[1]);
    expect(first.job.archiveEntry).toBe("a/catalogue.csv");
    expect(first.job.diagnostic.preview[0].values[0]).toBe("C-001");
    expect(second.job.archiveEntry).toBe("b/catalogue.xlsx");
    expect(second.job.diagnostic.preview[0].values[0]).toBe("X-002");
    const archive = await getSourceArchiveForImport(actorA, ids[0]);
    await expect(
      getSourceArchiveForImport(actorB, ids[0]),
    ).rejects.toMatchObject({ status: 404 });
    const restored: Buffer[] = [];
    for await (const chunk of store.read(archive.storageKey))
      restored.push(Buffer.from(chunk));
    expect(Buffer.concat(restored)).toEqual(original);
    await removeImport(actorA, ids[0], store);
    expect(await store.sample(archive.storageKey)).toBeTruthy();
    await removeImport(actorA, ids[1], store);
    await expect(store.sample(archive.storageKey)).rejects.toThrow();
    expect(
      await db
        .select()
        .from(sourceArchives)
        .where(eq(sourceArchives.id, archive.id)),
    ).toHaveLength(0);
  });
  it("annule entièrement un ZIP si une entrée échoue après la première", async () => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from("ref;nom\nA1;Valide\n"), "valide.csv");
    zip.addBuffer(Buffer.from('ref;nom\nB2;"incomplet'), "invalide.csv");
    zip.end();
    const chunks: Buffer[] = [];
    for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
    await expect(
      importZip(
        actorA,
        "lot-invalide.zip",
        new Blob([new Uint8Array(Buffer.concat(chunks))]).stream(),
        store,
      ),
    ).rejects.toThrow("Lecture CSV");
    expect(await listImports(actorA)).toHaveLength(0);
    expect(
      await db
        .select()
        .from(sourceArchives)
        .where(eq(sourceArchives.organizationId, actorA.organizationId)),
    ).toHaveLength(0);
    expect(await readdir(join(root, actorA.organizationId))).toEqual([]);
  });
  it("un second traitement de la même clé signée ne détruit pas l’archive déjà importée", async () => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from("ref;nom\nA1;Valide\n"), "catalogue.csv");
    zip.end();
    const chunks: Buffer[] = [];
    for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
    const stored = await store.put(
      actorA.organizationId,
      new Blob([new Uint8Array(Buffer.concat(chunks))]).stream(),
    );
    const [id] = await importSignedArchive(
      actorA,
      "lot.zip",
      stored.key,
      store,
    );
    await expect(
      importSignedArchive(actorA, "lot.zip", stored.key, store),
    ).rejects.toThrow();
    expect(await store.sample(stored.key)).toBeTruthy();
    expect((await getImport(actorA, id)).job.archiveEntry).toBe(
      "catalogue.csv",
    );
    await removeImport(actorA, id, store);
  });
  it("exécute réellement mapping, règles, rapport qualité et export téléchargeable", async () => {
    const id = await importCsv(
      actorA,
      "pipeline.csv",
      new Blob([
        "Référence;Désignation;Marque;Prix;Stock\nA001;Filtre;Bosch;12,50;4\nA 002;Plaquette;Bosch;19,90;2\nA003;Pièce invalide;Bosch;prix;1\n",
      ]).stream(),
      store,
    );
    const mapping = {
      supplier_reference: 0,
      product_name: 1,
      brand: 2,
      sale_price: 3,
      stock_quantity: 4,
    } as const;
    await saveMapping(
      actorA,
      id,
      mapping,
      DEFAULT_RULES,
      {},
      "Fournisseur test",
    );
    expect(
      (await listMappingTemplates(actorA)).map((item) => item.name),
    ).toContain("Fournisseur test");
    await queueImport(actorA, id);
    expect(await runJob(id)).toBe(true);
    const quality = await qualityRows(actorA, id);
    expect(quality.job.status).toBe("ready");
    expect(quality.job.counts).toMatchObject({
      total: 3,
      valid: 1,
      ambiguous: 1,
      invalid: 1,
    });
    expect(
      quality.rows
        .flatMap((row) => row.transformations)
        .every((change) => change.rule && change.version && change.origin),
    ).toBe(true);
    const exported = await createExport(
      actorA,
      id,
      defaultExportConfig("generic"),
      "Générique test",
    );
    expect((await getExport(actorA, exported.id)).rowCount).toBe(1);
    const chunks: Buffer[] = [];
    for await (const chunk of store.read(exported.storageKey))
      chunks.push(Buffer.from(chunk));
    const output = Buffer.concat(chunks).toString("utf8");
    expect(output).toContain("A001");
    expect(output).not.toContain("A 002");
    await removeImport(actorA, id, store);
    await expect(store.sample(exported.storageKey)).rejects.toThrow();
    await expect(store.sample(exported.reportKey)).rejects.toThrow();
  });
  it("empêche une relation inter-organisations au niveau SQL", async () => {
    const id = await importCsv(actorA, "original.csv", csv(), store);
    await expect(
      db.transaction(async (tx) => {
        await tx.delete(uploadedFiles).where(eq(uploadedFiles.importId, id));
        await tx.insert(uploadedFiles).values({
          organizationId: actorB.organizationId,
          importId: id,
          originalName: "cross.csv",
          storageKey: `${actorB.organizationId}/${randomUUID()}`,
          sizeBytes: 12,
          sha256: "x",
        });
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(
      db.insert(importJobs).values({
        organizationId: actorB.organizationId,
        createdBy: actorA.userId,
        diagnostic: (await getImport(actorA, id)).job.diagnostic,
      }),
    ).rejects.toThrow();
    await removeImport(actorA, id, store);
  });
  it("nettoie le fichier et ne persiste rien après une erreur de lecture", async () => {
    await expect(
      importCsv(
        actorA,
        "broken.csv",
        new Blob(['a;b\n1;"ouvert']).stream(),
        store,
      ),
    ).rejects.toThrow("Lecture CSV");
    expect(await listImports(actorA)).toHaveLength(0);
    expect(await readdir(join(root, actorA.organizationId))).toEqual([]);
  });
  it("refuse extension et nom de fichier trompeurs", async () => {
    await expect(importCsv(actorA, "test.xlsx", csv(), store)).rejects.toThrow(
      "XLSX",
    );
    await expect(
      importCsv(actorA, "../test.csv", csv(), store),
    ).rejects.toThrow("nom du fichier");
  });
  it("limite les tentatives même entre requêtes concurrentes", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => limitAuth(emailA)),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(10);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(2);
  });
});
