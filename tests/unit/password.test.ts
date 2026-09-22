import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../src/server/auth/password";
describe("mots de passe", () => {
  it("sale les empreintes et vérifie le bon mot de passe", async () => {
    const first = await hashPassword("un mot de passe privé");
    const second = await hashPassword("un mot de passe privé");
    expect(first).not.toBe(second);
    expect(first).not.toContain("privé");
    expect(await verifyPassword("un mot de passe privé", first)).toBe(true);
    expect(await verifyPassword("un autre mot de passe", first)).toBe(false);
  });
  it("refuse une empreinte malformée", async () => {
    expect(await verifyPassword("secret", "invalid")).toBe(false);
  });
});
