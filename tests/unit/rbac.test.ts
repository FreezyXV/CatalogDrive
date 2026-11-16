import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  authorize,
  can,
  normalizeRole,
} from "../../src/server/auth/rbac";
import {
  membershipsFromGroups,
  organizationNameFor,
  parseConnections,
} from "../../src/server/auth/oidc";

const ORG = "9b2f5c7e-1d3a-4e8b-a6c4-0f1e2d3c4b5a";
const OTHER = "3c8a1f0e-6b2d-4f7a-9e15-c2d4b6a8e0f1";

describe("RBAC par organisation", () => {
  it("applique la matrice des permissions", () => {
    const matrix = Object.fromEntries(
      (["admin", "operator", "reviewer"] as const).map((role) => [
        role,
        Object.keys(PERMISSIONS).filter((p) =>
          can(role, p as keyof typeof PERMISSIONS),
        ),
      ]),
    );
    expect(matrix).toEqual({
      admin: [
        "import:read",
        "row:review",
        "import:create",
        "mapping:edit",
        "processing:start",
        "export:create",
        "import:delete",
        "organization:manage",
      ],
      operator: [
        "import:read",
        "row:review",
        "import:create",
        "mapping:edit",
        "processing:start",
        "export:create",
      ],
      reviewer: ["import:read", "row:review"],
    });
  });

  it("traite les comptes historiques « owner » comme administrateurs", () => {
    expect(normalizeRole("owner")).toBe("admin");
  });

  it("moindre privilège pour un rôle inconnu ou révoqué", () => {
    for (const role of ["superuser", "revoked", "", null, undefined])
      expect(normalizeRole(role)).toBe("reviewer");
  });

  it("refuse avec un 403 explicite", () => {
    expect(() => authorize({ role: "reviewer" }, "export:create")).toThrow(
      expect.objectContaining({ status: 403 }),
    );
    expect(() =>
      authorize({ role: "operator" }, "export:create"),
    ).not.toThrow();
  });
});

describe("claim groups → organisations et rôles", () => {
  it("extrait organisation et rôle, garde le rôle le plus élevé", () => {
    const result = membershipsFromGroups([
      `/organizations/${ORG}/reviewer`,
      `/organizations/${ORG}/admin`,
      `/organizations/${OTHER}/operator`,
    ]);
    expect(Object.fromEntries(result)).toEqual({
      [ORG]: "admin",
      [OTHER]: "operator",
    });
  });

  it("ignore les groupes hors convention ou mal formés", () => {
    const result = membershipsFromGroups([
      "/organizations",
      `/organizations/${ORG}`,
      `/organizations/${ORG}/superadmin`,
      `/other/${ORG}/admin`,
      "/organizations/pas-un-uuid/admin",
      42,
    ]);
    expect(result.size).toBe(0);
    expect(membershipsFromGroups(undefined).size).toBe(0);
  });
});

describe("connexions sociales", () => {
  it("lit la liste OIDC_SOCIAL_CONNECTIONS et écarte les identifiants douteux", () => {
    expect(
      parseConnections(
        "google-oauth2:Google, windowslive:Microsoft,github,bad id:X",
      ),
    ).toEqual([
      { id: "google-oauth2", label: "Google" },
      { id: "windowslive", label: "Microsoft" },
      { id: "github", label: "github" },
    ]);
    expect(parseConnections(undefined)).toEqual([]);
  });

  it("nomme l’organisation personnelle d’après le profil", () => {
    expect(organizationNameFor({ name: "Ivan" })).toBe("Espace de Ivan");
    expect(organizationNameFor({ email: "ivan@example.test" })).toBe(
      "Espace de ivan",
    );
  });
});
