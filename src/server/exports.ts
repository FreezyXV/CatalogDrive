import { and, eq, sql, asc, desc } from "drizzle-orm";
import { Readable, Transform } from "node:stream";
import { stringify } from "csv-stringify";
import iconv from "iconv-lite";
import { db } from "./db";
import {
  importJobs,
  processedRows,
  exportJobs,
  exportTemplates,
  auditEvents,
  usageRecords,
} from "./db/schema";
import { getFileStore } from "./storage";
import { getImport } from "./imports";
import { lockImport, type Actor, type Transaction } from "./catalog";
import {
  cmsErrors,
  exportRecord,
  safeCsvCell,
  shopifyHandle,
  validateExportConfig,
  type ExportConfig,
} from "@/domain/exports";
import { HttpError } from "./http";

function csvStream(
  records: AsyncIterable<Record<string, string>>,
  config: ExportConfig,
) {
  const output = Readable.from(records).pipe(
    stringify({
      header: true,
      delimiter: config.delimiter,
      record_delimiter: "\r\n",
      bom: config.encoding === "utf-8-bom",
      cast: { string: safeCsvCell },
    }),
  );
  if (config.encoding !== "windows-1252")
    return Readable.toWeb(output) as ReadableStream<Uint8Array>;
  const validate = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const text = chunk.toString("utf8");
      const encoded = iconv.encode(text, "windows-1252");
      if (iconv.decode(encoded, "windows-1252") !== text)
        callback(
          new HttpError(
            422,
            "Certaines valeurs ne peuvent pas être représentées en Windows-1252. Choisissez UTF-8.",
          ),
        );
      else callback(null, encoded);
    },
  });
  output.on("error", (error) => validate.destroy(error));
  return Readable.toWeb(output.pipe(validate)) as ReadableStream<Uint8Array>;
}
async function* rows(tx: Transaction, actor: Actor, id: string) {
  let line = 0;
  while (true) {
    const batch = await tx
      .select()
      .from(processedRows)
      .where(
        and(
          eq(processedRows.importId, id),
          eq(processedRows.organizationId, actor.organizationId),
          sql`${processedRows.sourceLine}>${line}`,
        ),
      )
      .orderBy(asc(processedRows.sourceLine))
      .limit(200);
    if (!batch.length) break;
    for (const row of batch) {
      line = row.sourceLine;
      yield row;
    }
  }
}
export async function createExport(
  actor: Actor,
  id: string,
  config: ExportConfig,
  templateName?: string,
) {
  await getImport(actor, id);
  try {
    validateExportConfig(config);
  } catch (error) {
    throw new HttpError(422, (error as Error).message);
  }
  const store = getFileStore();
  const keys: string[] = [];
  try {
    return await db.transaction(async (tx) => {
      await lockImport(tx, id);
      const [job] = await tx
        .select()
        .from(importJobs)
        .where(
          and(
            eq(importJobs.id, id),
            eq(importJobs.organizationId, actor.organizationId),
          ),
        );
      if (job.status !== "ready")
        throw new HttpError(
          409,
          "Attendez la fin du traitement avant d’exporter.",
        );
      let accepted = 0,
        rejected = 0;
      const seenSkus = new Set<string>();
      const reasonFor = (
        row: typeof processedRows.$inferSelect,
        track = false,
      ) => {
        const reasons = row.excluded
          ? ["Ligne exclue manuellement"]
          : row.status !== "valid"
            ? row.issues.map((issue) => issue.message)
            : cmsErrors(row.data, config, job.rules!.priceBasis);
        if (
          !reasons.length &&
          !["generic", "custom"].includes(config.profile)
        ) {
          const sku = (row.data.sku ?? "").toUpperCase();
          if (seenSkus.has(sku))
            reasons.push(
              "SKU déjà exporté : un CMS exige un SKU unique, même entre marques.",
            );
          else if (track) seenSkus.add(sku);
        }
        return reasons;
      };
      const rejectedIds = new Map<string, string[]>();
      async function* catalogRecords() {
        for await (const row of rows(tx, actor, id)) {
          const reasons = reasonFor(row, true);
          if (reasons.length) {
            rejected++;
            rejectedIds.set(row.id, reasons);
            continue;
          }
          accepted++;
          yield exportRecord(
            row.data,
            { line: row.sourceLine, confidence: row.confidence },
            config,
          );
          if (
            config.profile === "shopify" &&
            config.columns.some((c) => c.field === "image_urls")
          ) {
            const imageHeader = config.columns.find(
              (c) => c.field === "image_urls",
            )!.header;
            for (const image of (row.data.image_urls ?? "")
              .split(" | ")
              .slice(1))
              if (image)
                yield {
                  "URL handle": shopifyHandle(row.data.sku!),
                  [imageHeader]: image,
                };
          }
        }
        if (!accepted)
          throw new HttpError(
            422,
            "Aucune ligne n’est exportable avec ce profil. Corrigez les anomalies et vérifiez les champs obligatoires du CMS.",
          );
      }
      const catalog = await store.put(
        actor.organizationId,
        csvStream(catalogRecords(), config),
        50 * 1024 * 1024,
      );
      keys.push(catalog.key);
      async function* reportRecords() {
        let reportCount = 0;
        for await (const row of rows(tx, actor, id)) {
          const reasons = rejectedIds.get(row.id);
          if (reasons)
            for (const reason of reasons) {
              reportCount++;
              yield {
                ligne: String(row.sourceLine),
                statut: row.excluded ? "exclue" : row.status,
                motif: reason,
                champ: "",
                original: "",
                transformation: "",
                regle: "",
              };
            }
          for (const change of row.transformations) {
            reportCount++;
            yield {
              ligne: String(row.sourceLine),
              statut: "transformation",
              motif: "Transformation traçable",
              champ: change.field,
              original: change.original,
              transformation: change.value,
              regle: `${change.rule}@${change.version}`,
            };
          }
          for (const [field, value] of Object.entries(
            exportRecord(
              row.data,
              { line: row.sourceLine, confidence: row.confidence },
              config,
            ),
          ))
            if (safeCsvCell(value) !== value) {
              reportCount++;
              yield {
                ligne: String(row.sourceLine),
                statut: "securite",
                motif: "Formule potentielle neutralisée dans le CSV",
                champ: field,
                original: value,
                transformation: safeCsvCell(value),
                regle: "csv_formula_escape@1.0.0",
              };
            }
        }
        if (!reportCount)
          yield {
            ligne: "",
            statut: "ok",
            motif: "Aucune anomalie ni transformation à signaler",
            champ: "",
            original: "",
            transformation: "",
            regle: "",
          };
      }
      const report = await store.put(
        actor.organizationId,
        csvStream(reportRecords(), {
          ...config,
          encoding: "utf-8-bom",
          delimiter: ";",
        }),
        50 * 1024 * 1024,
      );
      keys.push(report.key);
      const [exported] = await tx
        .insert(exportJobs)
        .values({
          organizationId: actor.organizationId,
          importId: id,
          config,
          storageKey: catalog.key,
          reportKey: report.key,
          rowCount: accepted,
          rejectedCount: rejected,
          sizeBytes: catalog.bytes + report.bytes,
        })
        .returning();
      if (templateName)
        await tx
          .insert(exportTemplates)
          .values({
            organizationId: actor.organizationId,
            name: templateName,
            config,
          })
          .onConflictDoUpdate({
            target: [exportTemplates.organizationId, exportTemplates.name],
            set: { config },
          });
      await tx.insert(usageRecords).values({
        organizationId: actor.organizationId,
        kind: "export",
        amount: 1,
        idempotencyKey: `export:${exported.id}`,
      });
      await tx
        .insert(auditEvents)
        .values({ ...actor, action: "export.created", entityId: exported.id });
      return exported;
    });
  } catch (error) {
    for (const key of keys) await store.remove(key);
    throw error;
  }
}
export async function getExport(actor: Actor, id: string) {
  const [result] = await db
    .select()
    .from(exportJobs)
    .where(
      and(
        eq(exportJobs.id, id),
        eq(exportJobs.organizationId, actor.organizationId),
      ),
    );
  if (!result) throw new HttpError(404, "Export introuvable.");
  return result;
}
export async function listExports(actor: Actor, id: string) {
  await getImport(actor, id);
  return db
    .select()
    .from(exportJobs)
    .where(
      and(
        eq(exportJobs.importId, id),
        eq(exportJobs.organizationId, actor.organizationId),
      ),
    )
    .orderBy(desc(exportJobs.createdAt))
    .limit(50);
}
export async function listExportTemplates(actor: Actor) {
  return db
    .select()
    .from(exportTemplates)
    .where(eq(exportTemplates.organizationId, actor.organizationId))
    .orderBy(desc(exportTemplates.createdAt));
}
