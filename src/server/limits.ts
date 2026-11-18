import { sql } from "drizzle-orm";
import { db } from "./db";
import { authAttempts } from "./db/schema";
import { HttpError } from "./http";

export async function limitAttempts(
  key: string,
  maximum: number,
  minutes: number,
  message: string,
) {
  const [attempt] = await db
    .insert(authAttempts)
    .values({
      key,
      count: 1,
      resetAt: new Date(Date.now() + minutes * 60_000),
    })
    .onConflictDoUpdate({
      target: authAttempts.key,
      set: {
        count: sql`CASE WHEN ${authAttempts.resetAt} < now() THEN 1 ELSE ${authAttempts.count} + 1 END`,
        resetAt: sql`CASE WHEN ${authAttempts.resetAt} < now() THEN now() + (${minutes} * interval '1 minute') ELSE ${authAttempts.resetAt} END`,
      },
    })
    .returning();
  if (attempt.count > maximum) throw new HttpError(429, message);
}
const hourlyLimits = {
  upload: 30,
  import: 30,
  mapping: 60,
  processing: 30,
  export: 60,
};

export function limitOrganizationAction(
  organizationId: string,
  action: keyof typeof hourlyLimits,
) {
  return limitAttempts(
    `organization:${organizationId}:${action}`,
    hourlyLimits[action],
    60,
    "Limite horaire de votre organisation atteinte. Réessayez dans une heure.",
  );
}
