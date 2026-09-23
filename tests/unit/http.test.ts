import { afterEach, describe, expect, it } from "vitest";
import { checkOrigin } from "../../src/server/http";

const originalOrigin = process.env.APP_ORIGIN;
const originalOrigins = process.env.APP_ORIGINS;
const originalVercelEnv = process.env.VERCEL_ENV;
const originalVercelUrl = process.env.VERCEL_URL;
const originalVercelBranchUrl = process.env.VERCEL_BRANCH_URL;
afterEach(() => {
  if (originalOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = originalOrigin;
  if (originalOrigins === undefined) delete process.env.APP_ORIGINS;
  else process.env.APP_ORIGINS = originalOrigins;
  if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalVercelEnv;
  if (originalVercelUrl === undefined) delete process.env.VERCEL_URL;
  else process.env.VERCEL_URL = originalVercelUrl;
  if (originalVercelBranchUrl === undefined)
    delete process.env.VERCEL_BRANCH_URL;
  else process.env.VERCEL_BRANCH_URL = originalVercelBranchUrl;
});

describe("contrôle des origines", () => {
  it("accepte seulement les domaines configurés explicitement", () => {
    process.env.APP_ORIGIN = "https://catalog-drive-ivans-projects.vercel.app";
    process.env.APP_ORIGINS = "https://catalog-drive.vercel.app";
    const request = (origin?: string) =>
      new Request("https://catalog-drive.vercel.app/api/auth/register", {
        headers: origin ? { origin } : {},
      });

    expect(() => checkOrigin(request(process.env.APP_ORIGIN))).not.toThrow();
    expect(() =>
      checkOrigin(request("https://catalog-drive.vercel.app")),
    ).not.toThrow();
    expect(() =>
      checkOrigin(request("https://catalog-drive.vercel.app.attacker.test")),
    ).toThrow("Origine de la requête refusée.");
    expect(() => checkOrigin(request())).toThrow(
      "Origine de la requête refusée.",
    );
  });
  it("accepte ses deux URL Vercel de prévisualisation sans ouvrir les autres branches", () => {
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_URL = "catalog-drive-a1b2c3.vercel.app";
    process.env.VERCEL_BRANCH_URL =
      "catalog-drive-git-codex-b2-200mb.vercel.app";
    const request = (origin: string) =>
      new Request("https://catalog-drive-a1b2c3.vercel.app/api/imports", {
        headers: { origin },
      });
    expect(() =>
      checkOrigin(request(`https://${process.env.VERCEL_URL}`)),
    ).not.toThrow();
    expect(() =>
      checkOrigin(request(`https://${process.env.VERCEL_BRANCH_URL}`)),
    ).not.toThrow();
    expect(() =>
      checkOrigin(request("https://another-preview.vercel.app")),
    ).toThrow("Origine de la requête refusée.");
    process.env.VERCEL_ENV = "production";
    expect(() =>
      checkOrigin(request(`https://${process.env.VERCEL_URL}`)),
    ).toThrow("Origine de la requête refusée.");
  });
});
