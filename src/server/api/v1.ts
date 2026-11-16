import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { ZodError } from "zod";
import { db } from "../db";
import { exportRequests, processedRows } from "../db/schema";
import { HttpError } from "../http";
import { ImportError } from "@/domain/csv";
import {
  oidcConfig,
  provisionPrincipal,
  scopesOf,
  verifyJwt,
} from "../auth/oidc";
import { authorize, type Permission, type Role } from "../auth/rbac";
import type { getImport } from "../imports";

/**
 * Shared plumbing of the public API v1 (contract:
 * openapi/catamotive-public-api.v1.yaml).
 *
 * Every request is authenticated by a Bearer JWT, then authorised twice:
 * the OAuth2 scope says what the *client application* may do, the role in
 * the organization says what the *principal* may do. Both must allow it.
 */
export const API_VERSION = "1.0.0";
export type Scope = "catalog:read" | "catalog:write" | "catalog:export";
export type ApiPrincipal = {
  userId: string;
  organizationId: string;
  role: Role;
  clientId: string | null;
  correlationId: string;
};

export class ApiError extends HttpError {
  constructor(
    status: number,
    message: string,
    public headers: Record<string, string> = {},
  ) {
    super(status, message);
  }
}

const CORRELATION = /^[A-Za-z0-9._-]{1,64}$/;
export function correlationIdFrom(request: Request) {
  const supplied = request.headers.get("x-correlation-id");
  return supplied && CORRELATION.test(supplied) ? supplied : randomUUID();
}

const challenge = (extra = "") =>
  `Bearer realm="catamotive"${extra ? `, ${extra}` : ""}`;

export async function requireApiPrincipal(
  request: Request,
  scope: Scope,
  permission: Permission,
): Promise<ApiPrincipal> {
  const correlationId = correlationIdFrom(request);
  const config = oidcConfig();
  if (!config)
    throw new ApiError(
      503,
      "API publique indisponible : aucun fournisseur d’identité configuré.",
    );
  const match = /^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/i.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!match)
    throw new ApiError(401, "Jeton d’accès requis.", {
      "WWW-Authenticate": challenge(),
    });
  const claims = await verifyJwt(match[1], config.apiAudience, config).catch(
    () => {
      throw new ApiError(
        401,
        "Jeton invalide, expiré ou d’une autre audience.",
        {
          "WWW-Authenticate": challenge('error="invalid_token"'),
        },
      );
    },
  );
  if (!scopesOf(claims).has(scope))
    throw new ApiError(403, `Scope OAuth2 requis : ${scope}.`, {
      "WWW-Authenticate": challenge(
        `error="insufficient_scope", scope="${scope}"`,
      ),
    });
  const { user, granted } = await provisionPrincipal(claims, {
    groupsClaim: config.groupsClaim,
  });
  const requested = request.headers.get("x-organization-id")?.toLowerCase();
  if (!requested && granted.size > 1)
    throw new ApiError(
      400,
      "Ce jeton couvre plusieurs organisations : précisez l’en-tête X-Organization-ID.",
    );
  const organizationId = requested ?? [...granted.keys()][0];
  const role = granted.get(organizationId);
  if (!role)
    throw new ApiError(403, "Organisation non autorisée pour ce jeton.");
  authorize({ role }, permission);
  return {
    userId: user.id,
    organizationId,
    role,
    clientId: claims.azp ?? null,
    correlationId,
  };
}

const PROBLEM_TYPES: Record<number, string> = {
  400: "bad-request",
  401: "unauthorized",
  403: "forbidden",
  404: "not-found",
  409: "conflict",
  413: "payload-too-large",
  422: "unprocessable",
  503: "unavailable",
};

/** RFC 9457 Problem Details. */
export function problem(error: unknown, request: Request) {
  const correlationId = correlationIdFrom(request);
  let status = 500;
  let detail = "Une erreur interne est survenue.";
  let headers: Record<string, string> = {};
  if (error instanceof HttpError) {
    status = error.status;
    detail = error.message;
    if (error instanceof ApiError) headers = error.headers;
  } else if (error instanceof ImportError) {
    status = 422;
    detail = error.message;
  } else if (error instanceof ZodError) {
    status = 400;
    detail = error.issues[0]?.message ?? "Données invalides.";
  } else
    console.error(
      JSON.stringify({
        event: "api.error",
        correlationId,
        error: error instanceof Error ? error.name : "UnknownError",
      }),
    );
  const type = PROBLEM_TYPES[status] ?? "internal";
  return Response.json(
    {
      type: `https://catamotive.dev/problems/${type}`,
      title: type.replaceAll("-", " "),
      status,
      detail,
      instance: new URL(request.url).pathname,
      correlationId,
    },
    {
      status,
      headers: {
        "Content-Type": "application/problem+json",
        "X-Correlation-ID": correlationId,
        "Cache-Control": "no-store",
        ...headers,
      },
    },
  );
}

export function json(
  body: unknown,
  principal: Pick<ApiPrincipal, "correlationId">,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return Response.json(body, {
    status: init.status ?? 200,
    headers: {
      "X-Correlation-ID": principal.correlationId,
      "Cache-Control": "private, no-store",
      ...init.headers,
    },
  });
}

type ImportRecord = Awaited<ReturnType<typeof getImport>>;
export function importResource({ job, file }: ImportRecord) {
  const base = `/api/v1/imports/${job.id}`;
  return {
    id: job.id,
    status: job.status,
    file: {
      name: file.originalName,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    },
    diagnostic: {
      format: job.diagnostic.format ?? "csv",
      encoding: job.diagnostic.encoding,
      delimiter: job.diagnostic.delimiter,
      sheet: job.diagnostic.sheet,
      headers: job.diagnostic.headers,
      rowCount: job.diagnostic.rowCount,
      warnings: job.diagnostic.warnings,
    },
    processedCount: job.processedCount,
    counts: job.counts ?? null,
    error: job.error ?? null,
    links: {
      self: base,
      mapping: `${base}/mapping`,
      processing: `${base}/processing`,
      rejectedLines: `${base}/rejected-lines`,
      exports: `${base}/exports`,
    },
    createdAt: job.createdAt.toISOString(),
  };
}

export function exportRequestResource(
  request: typeof exportRequests.$inferSelect,
) {
  return {
    id: request.id,
    importId: request.importId,
    profile: request.profile,
    status: request.status,
    route: request.route,
    exportId: request.exportId,
    rowCount: request.rowCount,
    rejectedCount: request.rejectedCount,
    error: request.error,
    links: {
      self: `/api/v1/export-requests/${request.id}`,
      ...(request.exportId
        ? {
            file: `/api/v1/exports/${request.exportId}/file`,
            report: `/api/v1/exports/${request.exportId}/report`,
          }
        : {}),
    },
    createdAt: request.createdAt.toISOString(),
  };
}

export async function rejectedLines(
  organizationId: string,
  importId: string,
  page: number,
) {
  const where = and(
    eq(processedRows.importId, importId),
    eq(processedRows.organizationId, organizationId),
    eq(processedRows.status, "invalid"),
    eq(processedRows.excluded, 0),
  );
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(processedRows)
    .where(where);
  const rows = await db
    .select({
      sourceLine: processedRows.sourceLine,
      raw: processedRows.raw,
      issues: processedRows.issues,
    })
    .from(processedRows)
    .where(where)
    .orderBy(asc(processedRows.sourceLine))
    .limit(50)
    .offset((page - 1) * 50);
  return {
    items: rows.map((row) => ({
      sourceLine: row.sourceLine,
      raw: row.raw,
      issues: row.issues.map((issue) => ({
        field: issue.field,
        code: issue.code,
        severity: issue.severity,
        original: issue.original,
        suggestion: issue.suggestion,
        message: issue.message,
      })),
    })),
    page,
    total,
  };
}
