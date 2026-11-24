import { HttpError } from "../http";

/**
 * Role-Based Access Control, evaluated per organization.
 *
 * A user holds one role in each organization (memberships.role). With OIDC
 * the role comes from the identity provider (Keycloak group
 * /organizations/<organization-id>/<role>) and is re-synchronised at every
 * login: the IdP is the source of truth, the application enforces.
 *
 * Least privilege: an unknown role maps to `reviewer`.
 */
export const ROLES = ["admin", "operator", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = {
  "import:read": ["admin", "operator", "reviewer"],
  "row:review": ["admin", "operator", "reviewer"],
  "import:create": ["admin", "operator"],
  "mapping:edit": ["admin", "operator"],
  "processing:start": ["admin", "operator"],
  "export:create": ["admin", "operator"],
  "import:delete": ["admin"],
  "organization:manage": ["admin"],
  "store:manage": ["admin"],
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Administrateur",
  operator: "Opérateur",
  reviewer: "Relecteur",
};

export function normalizeRole(role: string | null | undefined): Role {
  // Accounts created before RBAC are organization owners.
  if (role === "owner") return "admin";
  return (ROLES as readonly string[]).includes(role ?? "")
    ? (role as Role)
    : "reviewer";
}

export function can(role: string | null | undefined, permission: Permission) {
  return (PERMISSIONS[permission] as readonly Role[]).includes(
    normalizeRole(role),
  );
}

export function authorize(
  subject: { role?: string | null },
  permission: Permission,
) {
  if (!can(subject.role, permission))
    throw new HttpError(
      403,
      `Action réservée aux rôles : ${PERMISSIONS[permission]
        .map((role) => ROLE_LABELS[role])
        .join(", ")}.`,
    );
}
