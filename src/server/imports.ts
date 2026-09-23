import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import {
  auditEvents,
  exportJobs,
  importJobs,
  organizations,
  uploadedFiles,
} from "./db/schema";
import type { Identity } from "./auth";
import { getFileStore, type FileStore } from "./storage";
import { ImportError } from "@/domain/csv";
import { inspectSource } from "./source";
import { HttpError } from "./http";
import { createHash } from "node:crypto";

type Actor = Pick<Identity, "userId" | "organizationId">;
const selectImport = () =>
  db
    .select({ job: importJobs, file: uploadedFiles })
    .from(importJobs)
    .innerJoin(
      uploadedFiles,
      and(
        eq(uploadedFiles.importId, importJobs.id),
        eq(uploadedFiles.organizationId, importJobs.organizationId),
      ),
    );
export async function listImports(actor: Actor) {
  return selectImport()
    .where(eq(importJobs.organizationId, actor.organizationId))
    .orderBy(desc(importJobs.createdAt))
    .limit(100);
}
export async function getImport(actor: Actor, id: string) {
  if (!z.uuid().safeParse(id).success)
    throw new HttpError(404, "Import introuvable.");
  const [result] = await selectImport()
    .where(
      and(
        eq(importJobs.organizationId, actor.organizationId),
        eq(importJobs.id, id),
      ),
    )
    .limit(1);
  if (!result) throw new HttpError(404, "Import introuvable.");
  return result;
}
export async function importCsv(
  actor: Actor,
  originalName: string,
  body: ReadableStream<Uint8Array>,
  store: FileStore = getFileStore(),
) {
  if (!/\.(csv|xlsx)$/i.test(originalName))
    throw new ImportError("Choisissez un fichier CSV ou XLSX.");
  if (originalName.length > 180 || /[\x00-\x1f\x7f/\\]/.test(originalName))
    throw new ImportError(
      "Le nom du fichier est invalide ou trop long (180 caractères maximum).",
    );
  const stored = await store.put(actor.organizationId, body);
  try {
    const diagnostic = await inspectSource(store, stored.key, originalName);
    return await db.transaction(async (tx) => {
      const [job] = await tx
        .insert(importJobs)
        .values({
          organizationId: actor.organizationId,
          createdBy: actor.userId,
          diagnostic,
          readOptions: {
            headerLine: diagnostic.headerLine,
            delimiter:
              diagnostic.format === "xlsx"
                ? undefined
                : (diagnostic.delimiter as "," | ";" | "\t"),
            encoding: diagnostic.encoding,
            sheet: diagnostic.sheet,
          },
        })
        .returning();
      await tx.insert(uploadedFiles).values({
        organizationId: actor.organizationId,
        importId: job.id,
        originalName,
        storageKey: stored.key,
        sizeBytes: stored.bytes,
        sha256: stored.sha256,
      });
      await tx
        .insert(auditEvents)
        .values({ ...actor, action: "import.created", entityId: job.id });
      return job.id;
    });
  } catch (error) {
    await store.remove(stored.key);
    throw error;
  }
}

export async function importSignedUpload(
  actor: Actor,
  originalName: string,
  storageKey: string,
  store: FileStore = getFileStore(),
) {
  if (!/\.(csv|xlsx)$/i.test(originalName))
    throw new ImportError("Choisissez un fichier CSV ou XLSX.");
  if (originalName.length > 180 || /[\x00-\x1f\x7f/\\]/.test(originalName))
    throw new ImportError(
      "Le nom du fichier est invalide ou trop long (180 caractères maximum).",
    );
  const objectKey = storageKey.startsWith("incoming/")
    ? storageKey.slice("incoming/".length)
    : storageKey;
  if (!objectKey.startsWith(`${actor.organizationId}/`))
    throw new HttpError(403, "Clé d’upload non autorisée.");
  let bytes = 0;
  const hash = createHash("sha256");
  try {
    for await (const chunk of store.read(storageKey)) {
      const buffer = Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      if (bytes > 5 * 1024 * 1024)
        throw new ImportError("Le fichier dépasse la limite de 5 Mio.");
      hash.update(buffer);
    }
    if (!bytes) throw new ImportError("Le fichier est vide.");
    const diagnostic = await inspectSource(store, storageKey, originalName);
    return await db.transaction(async (tx) => {
      const [job] = await tx
        .insert(importJobs)
        .values({
          organizationId: actor.organizationId,
          createdBy: actor.userId,
          diagnostic,
          readOptions: {
            headerLine: diagnostic.headerLine,
            delimiter:
              diagnostic.format === "xlsx"
                ? undefined
                : (diagnostic.delimiter as "," | ";" | "\t"),
            encoding: diagnostic.encoding,
            sheet: diagnostic.sheet,
          },
        })
        .returning();
      await tx.insert(uploadedFiles).values({
        organizationId: actor.organizationId,
        importId: job.id,
        originalName,
        storageKey,
        sizeBytes: bytes,
        sha256: hash.digest("hex"),
      });
      await tx
        .insert(auditEvents)
        .values({ ...actor, action: "import.created", entityId: job.id });
      return job.id;
    });
  } catch (error) {
    await store.remove(storageKey).catch(() => undefined);
    throw error;
  }
}
export async function removeImport(
  actor: Actor,
  id: string,
  store: FileStore = getFileStore(),
) {
  const { file } = await getImport(actor, id);
  const exports = await db
    .select({
      storageKey: exportJobs.storageKey,
      reportKey: exportJobs.reportKey,
    })
    .from(exportJobs)
    .where(
      and(
        eq(exportJobs.importId, id),
        eq(exportJobs.organizationId, actor.organizationId),
      ),
    );
  await store.remove(file.storageKey);
  for (const item of exports) {
    await store.remove(item.storageKey);
    await store.remove(item.reportKey);
  }
  await db.transaction(async (tx) => {
    await tx
      .delete(importJobs)
      .where(
        and(
          eq(importJobs.organizationId, actor.organizationId),
          eq(importJobs.id, id),
        ),
      );
    await tx
      .insert(auditEvents)
      .values({ ...actor, action: "import.deleted", entityId: id });
  });
}

export async function purgeExpiredImports(store: FileStore = getFileStore()) {
  const expired = await db
    .select({
      id: importJobs.id,
      userId: importJobs.createdBy,
      organizationId: importJobs.organizationId,
    })
    .from(importJobs)
    .innerJoin(organizations, eq(organizations.id, importJobs.organizationId))
    .where(
      sql`${importJobs.createdAt} < now() - (${organizations.retentionDays} * interval '1 day')`,
    )
    .limit(100);
  let deleted = 0;
  for (const item of expired) {
    await removeImport(
      { userId: item.userId, organizationId: item.organizationId },
      item.id,
      store,
    );
    deleted++;
  }
  return deleted;
}
