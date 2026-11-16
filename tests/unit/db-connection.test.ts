import { describe, expect, it } from "vitest";
import {
  isTransactionPooler,
  normalizeDatabaseUrl,
} from "../../src/server/db/connection";

const neonPooled =
  "postgresql://u:p@ep-x-123-pooler.c-8.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
const neonDirect =
  "postgresql://u:p@ep-x-123.c-8.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

describe("URL PostgreSQL", () => {
  it("retire channel_binding et vérifie le certificat d'un hôte distant", () => {
    const url = new URL(normalizeDatabaseUrl(neonPooled));
    expect(url.searchParams.has("channel_binding")).toBe(false);
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
    expect(url.pathname).toBe("/neondb");
  });

  it("laisse une base locale inchangée", () => {
    const local = "postgresql://u:p@127.0.0.1:55439/catamotive";
    expect(normalizeDatabaseUrl(local)).toBe(local);
  });

  it("détecte les poolers transactionnels Neon et Supabase", () => {
    expect(isTransactionPooler(neonPooled)).toBe(true);
    expect(isTransactionPooler(neonDirect)).toBe(false);
    expect(
      isTransactionPooler("postgresql://u:p@aws-0.pooler.supabase.com:6543/db"),
    ).toBe(true);
    expect(isTransactionPooler("postgresql://u:p@127.0.0.1:5432/db")).toBe(
      false,
    );
  });
});
