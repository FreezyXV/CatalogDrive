import { and, eq } from "drizzle-orm";
import { exportRequests } from "../db/schema";

export type ExportAttempt = {
  id: string;
  attempts: number;
  organizationId: string;
  importId: string;
};

export function activeExportAttempt(attempt: ExportAttempt) {
  return and(
    eq(exportRequests.id, attempt.id),
    eq(exportRequests.organizationId, attempt.organizationId),
    eq(exportRequests.importId, attempt.importId),
    eq(exportRequests.status, "processing"),
    eq(exportRequests.attempts, attempt.attempts),
  );
}
