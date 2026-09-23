import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { db } from "./db";
import {
  auditEvents,
  exportJobs,
  importJobs,
  organizations,
  sourceArchives,
  uploadedFiles,
} from "./db/schema";
import type { Identity } from "./auth";
import { getFileStore, type FileStore, type StoredFile } from "./storage";
import { ImportError, type Diagnostic } from "@/domain/csv";
import { uploadLimitBytes, uploadLimitLabel } from "@/domain/upload-limit";
import { inspectSource } from "./source";
import { forEachCatalogArchiveEntry, activeArchiveLimits } from "./archives";
import { HttpError } from "./http";
import { createHash } from "node:crypto";

type Actor = Pick<Identity, "userId" | "organizationId">;
function validateFilename(name: string, archive = false) {
  if (!(archive ? /\.zip$/i : /\.(csv|xlsx)$/i).test(name))
    throw new ImportError(
      archive
        ? "Choisissez une archive ZIP contenant des CSV ou XLSX."
        : "Choisissez un fichier CSV ou XLSX.",
    );
  if (name.length > 180 || /[\x00-\x1f\x7f/\\]/.test(name))
    throw new ImportError(
      "Le nom du fichier est invalide ou trop long (180 caractères maximum).",
    );
}
function readOptionsFrom(diagnostic: Diagnostic) {
  return {
    headerLine: diagnostic.headerLine,
    delimiter:
      diagnostic.format === "xlsx"
        ? undefined
        : (diagnostic.delimiter as "," | ";" | "\t"),
    encoding: diagnostic.encoding,
    sheet: diagnostic.sheet,
  };
}
function assertOwnedStorageKey(actor: Actor, storageKey: string) {
  const objectKey = storageKey.startsWith("incoming/")
    ? storageKey.slice("incoming/".length)
    : storageKey;
  if (!objectKey.startsWith(`${actor.organizationId}/`))
    throw new HttpError(403, "Clé d’upload non autorisée.");
}
async function verifySignedSource(
  actor: Actor,
  storageKey: string,
  store: FileStore,
): Promise<StoredFile> {
  assertOwnedStorageKey(actor, storageKey);
  let bytes = 0;
  const hash = createHash("sha256");
  for await (const chunk of store.read(storageKey)) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > uploadLimitBytes())
      throw new ImportError(
        `Le fichier dépasse la limite de ${uploadLimitLabel()}.`,
      );
    hash.update(buffer);
  }
  if (!bytes) throw new ImportError("Le fichier est vide.");
  return { key: storageKey, bytes, sha256: hash.digest("hex") };
}
async function removeUnclaimedSource(store: FileStore, key: string) {
  const [file] = await db
    .select({ id: uploadedFiles.id })
    .from(uploadedFiles)
    .where(eq(uploadedFiles.storageKey, key))
    .limit(1);
  const [archive] = await db
    .select({ id: sourceArchives.id })
    .from(sourceArchives)
    .where(eq(sourceArchives.storageKey, key))
    .limit(1);
  if (!file && !archive) await store.remove(key).catch(() => undefined);
}
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
  validateFilename(originalName);
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
          readOptions: readOptionsFrom(diagnostic),
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
  validateFilename(originalName);
  assertOwnedStorageKey(actor, storageKey);
  try {
    const stored = await verifySignedSource(actor, storageKey, store);
    const diagnostic = await inspectSource(store, storageKey, originalName);
    return await db.transaction(async (tx) => {
      const [job] = await tx
        .insert(importJobs)
        .values({
          organizationId: actor.organizationId,
          createdBy: actor.userId,
          diagnostic,
          readOptions: readOptionsFrom(diagnostic),
        })
        .returning();
      await tx.insert(uploadedFiles).values({
        organizationId: actor.organizationId,
        importId: job.id,
        originalName,
        storageKey,
        sizeBytes: stored.bytes,
        sha256: stored.sha256,
      });
      await tx
        .insert(auditEvents)
        .values({ ...actor, action: "import.created", entityId: job.id });
      return job.id;
    });
  } catch (error) {
    await removeUnclaimedSource(store, storageKey);
    throw error;
  }
}

async function importStoredArchive(
  actor: Actor,
  originalName: string,
  archive: StoredFile,
  store: FileStore,
) {
  let dir: string | undefined;
  const extracted: {
    entry: string;
    filename: string;
    stored: StoredFile;
    diagnostic: Diagnostic;
  }[] = [];
  const extractedKeys: string[] = [];
  try {
    dir = await mkdtemp(join(tmpdir(), "catamotive-archive-"));
    const path = join(dir, "source.zip");
    await pipeline(
      store.read(archive.key),
      createWriteStream(path, { mode: 0o600 }),
    );
    await forEachCatalogArchiveEntry(
      path,
      activeArchiveLimits(),
      async (entry, stream, maxBytes) => {
        const stored = await store.put(
          actor.organizationId,
          Readable.toWeb(stream) as ReadableStream<Uint8Array>,
          maxBytes,
        );
        extractedKeys.push(stored.key);
        const diagnostic = await inspectSource(
          store,
          stored.key,
          entry.filename,
        );
        extracted.push({
          entry: entry.name,
          filename: entry.filename,
          stored,
          diagnostic,
        });
        return stored.bytes;
      },
    );
    return await db.transaction(async (tx) => {
      const [sourceArchive] = await tx
        .insert(sourceArchives)
        .values({
          organizationId: actor.organizationId,
          createdBy: actor.userId,
          originalName,
          storageKey: archive.key,
          sizeBytes: archive.bytes,
          sha256: archive.sha256,
          entryCount: extracted.length,
        })
        .returning();
      const ids: string[] = [];
      for (const item of extracted) {
        const [job] = await tx
          .insert(importJobs)
          .values({
            organizationId: actor.organizationId,
            createdBy: actor.userId,
            archiveId: sourceArchive.id,
            archiveEntry: item.entry,
            diagnostic: item.diagnostic,
            readOptions: readOptionsFrom(item.diagnostic),
          })
          .returning();
        await tx.insert(uploadedFiles).values({
          organizationId: actor.organizationId,
          importId: job.id,
          originalName: item.filename,
          storageKey: item.stored.key,
          sizeBytes: item.stored.bytes,
          sha256: item.stored.sha256,
        });
        await tx.insert(auditEvents).values({
          ...actor,
          action: "import.created",
          entityId: job.id,
        });
        ids.push(job.id);
      }
      await tx.insert(auditEvents).values({
        ...actor,
        action: "archive.created",
        entityId: sourceArchive.id,
      });
      return ids;
    });
  } catch (error) {
    for (const key of extractedKeys)
      await store.remove(key).catch(() => undefined);
    await removeUnclaimedSource(store, archive.key);
    throw error;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

export async function importZip(
  actor: Actor,
  originalName: string,
  body: ReadableStream<Uint8Array>,
  store: FileStore = getFileStore(),
) {
  validateFilename(originalName, true);
  const archive = await store.put(actor.organizationId, body);
  return importStoredArchive(actor, originalName, archive, store);
}

export async function importSignedArchive(
  actor: Actor,
  originalName: string,
  storageKey: string,
  store: FileStore = getFileStore(),
) {
  validateFilename(originalName, true);
  assertOwnedStorageKey(actor, storageKey);
  try {
    const archive = await verifySignedSource(actor, storageKey, store);
    return await importStoredArchive(actor, originalName, archive, store);
  } catch (error) {
    await removeUnclaimedSource(store, storageKey);
    throw error;
  }
}

export async function getSourceArchiveForImport(actor: Actor, id: string) {
  const { job } = await getImport(actor, id);
  if (!job.archiveId) throw new HttpError(404, "Archive introuvable.");
  const [archive] = await db
    .select()
    .from(sourceArchives)
    .where(
      and(
        eq(sourceArchives.id, job.archiveId),
        eq(sourceArchives.organizationId, actor.organizationId),
      ),
    )
    .limit(1);
  if (!archive) throw new HttpError(404, "Archive introuvable.");
  return archive;
}
export async function removeImport(
  actor: Actor,
  id: string,
  store: FileStore = getFileStore(),
) {
  const { job, file } = await getImport(actor, id);
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
  const archivedKey = await db.transaction(async (tx) => {
    if (job.archiveId)
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${job.archiveId}, 0))`,
      );
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
    if (!job.archiveId) return null;
    const [remaining] = await tx
      .select({ id: importJobs.id })
      .from(importJobs)
      .where(
        and(
          eq(importJobs.archiveId, job.archiveId),
          eq(importJobs.organizationId, actor.organizationId),
        ),
      )
      .limit(1);
    if (remaining) return null;
    const [archive] = await tx
      .delete(sourceArchives)
      .where(
        and(
          eq(sourceArchives.id, job.archiveId),
          eq(sourceArchives.organizationId, actor.organizationId),
        ),
      )
      .returning({ storageKey: sourceArchives.storageKey });
    return archive?.storageKey ?? null;
  });
  if (archivedKey) await store.remove(archivedKey);
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
