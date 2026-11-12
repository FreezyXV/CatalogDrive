import { z } from "zod";

/**
 * Message contracts exchanged over RabbitMQ.
 *
 * Every message is a JSON envelope validated with zod on both sides:
 * the producer cannot publish an invalid message and the consumer
 * rejects (to the dead letter queue) anything it cannot parse.
 * `schemaVersion` lets consumers evolve without a big-bang deployment.
 */
export const SCHEMA_VERSION = 1;

const envelope = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  organizationId: z.uuid(),
};

export const importProcessCommand = z.object({
  ...envelope,
  type: z.literal("import.process"),
  importId: z.uuid(),
  requestedBy: z.uuid(),
  /** Detected source format, read by the content-based router. */
  sourceFormat: z.enum(["csv", "xlsx", "xls", "ods"]),
  rowCount: z.number().int().nonnegative(),
});

export const exportGenerateCommand = z.object({
  ...envelope,
  type: z.literal("export.generate"),
  requestId: z.uuid(),
  importId: z.uuid(),
  requestedBy: z.uuid(),
  /** Target profile, read by the content-based router. */
  profile: z.enum([
    "generic",
    "woocommerce",
    "prestashop",
    "shopify",
    "custom",
  ]),
});

export const rejectedLinesEvent = z.object({
  ...envelope,
  type: z.literal("import.lines.rejected"),
  importId: z.uuid(),
  batch: z.number().int().positive(),
  batchCount: z.number().int().positive(),
  lines: z
    .array(
      z.object({
        sourceLine: z.number().int().positive(),
        raw: z.array(z.string()),
        issues: z.array(
          z.object({
            field: z.string(),
            code: z.string(),
            severity: z.string(),
            message: z.string(),
          }),
        ),
      }),
    )
    .max(500),
});

export const importProcessedEvent = z.object({
  ...envelope,
  type: z.enum(["import.processing.completed", "import.processing.failed"]),
  importId: z.uuid(),
  counts: z.record(z.string(), z.number()).nullable(),
  error: z.string().nullable(),
});

export const exportCompletedEvent = z.object({
  ...envelope,
  type: z.enum(["export.completed", "export.failed"]),
  requestId: z.uuid(),
  importId: z.uuid(),
  exportId: z.uuid().nullable(),
  error: z.string().nullable(),
});

export const integrationMessage = z.discriminatedUnion("type", [
  importProcessCommand,
  exportGenerateCommand,
  rejectedLinesEvent,
  importProcessedEvent,
  exportCompletedEvent,
]);

export type ImportProcessCommand = z.infer<typeof importProcessCommand>;
export type ExportGenerateCommand = z.infer<typeof exportGenerateCommand>;
export type RejectedLinesEvent = z.infer<typeof rejectedLinesEvent>;
export type IntegrationMessage = z.infer<typeof integrationMessage>;
export type MessageType = IntegrationMessage["type"];

/** Metadata carried as AMQP properties and headers, never in the body. */
export type MessageMetadata = {
  messageId: string;
  correlationId: string;
  type: MessageType;
  organizationId: string;
  timestamp: number;
};
