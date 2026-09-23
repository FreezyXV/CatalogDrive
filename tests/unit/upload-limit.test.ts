import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_UPLOAD_BYTES,
  SMALL_UPLOAD_BYTES,
  SUPABASE_FREE_UPLOAD_BYTES,
  uploadLimitBytes,
  uploadLimitLabel,
} from "../../src/domain/upload-limit";
import { activeArchiveLimits } from "../../src/server/archives";

const previous = process.env.UPLOAD_MAX_BYTES;
afterEach(() => {
  if (previous === undefined) delete process.env.UPLOAD_MAX_BYTES;
  else process.env.UPLOAD_MAX_BYTES = previous;
});

describe("plafond de dépôt explicite", () => {
  it("utilise 50 Mo sans configuration", () => {
    delete process.env.UPLOAD_MAX_BYTES;
    expect(uploadLimitBytes()).toBe(DEFAULT_UPLOAD_BYTES);
    expect(uploadLimitLabel()).toBe("50 Mo");
  });
  it("permet de revenir explicitement à 5 Mio", () => {
    process.env.UPLOAD_MAX_BYTES = String(SMALL_UPLOAD_BYTES);
    expect(uploadLimitBytes()).toBe(SMALL_UPLOAD_BYTES);
    expect(uploadLimitLabel()).toBe("5 Mio");
  });
  it("confirme les limites ZIP actives de 50 Mo", () => {
    process.env.UPLOAD_MAX_BYTES = String(SUPABASE_FREE_UPLOAD_BYTES);
    expect(uploadLimitBytes()).toBe(SUPABASE_FREE_UPLOAD_BYTES);
    expect(activeArchiveLimits()).toMatchObject({
      entryBytes: 50_000_000,
      totalBytes: 100 * 1024 * 1024,
    });
  });
  it("refuse toute valeur non étudiée", () => {
    process.env.UPLOAD_MAX_BYTES = "200000000";
    expect(() => uploadLimitBytes()).toThrow("UPLOAD_MAX_BYTES");
  });
});
