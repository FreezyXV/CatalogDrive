import { afterEach, describe, expect, it } from "vitest";
import { checkOrigin } from "../../src/server/http";

const originalOrigin = process.env.APP_ORIGIN;
const originalOrigins = process.env.APP_ORIGINS;
afterEach(() => {
  if (originalOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = originalOrigin;
  if (originalOrigins === undefined) delete process.env.APP_ORIGINS;
  else process.env.APP_ORIGINS = originalOrigins;
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
});
