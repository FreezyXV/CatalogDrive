/**
 * Public API v1 exercised with real OAuth2 tokens issued by Keycloak
 * (client_credentials). Skipped when OIDC_ISSUER is not configured.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq, inArray, like } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../../src/server/db";
import {
  auditEvents,
  importJobs,
  memberships,
  usageRecords,
  users,
} from "../../src/server/db/schema";
import * as imports from "../../src/app/api/v1/imports/route";
import * as oneImport from "../../src/app/api/v1/imports/[importId]/route";
import * as mapping from "../../src/app/api/v1/imports/[importId]/mapping/route";
import * as processing from "../../src/app/api/v1/imports/[importId]/processing/route";
import * as rejected from "../../src/app/api/v1/imports/[importId]/rejected-lines/route";
import * as exportsRoute from "../../src/app/api/v1/imports/[importId]/exports/route";
import * as exportRequest from "../../src/app/api/v1/export-requests/[requestId]/route";
import * as download from "../../src/app/api/v1/exports/[exportId]/[kind]/route";
import * as health from "../../src/app/api/v1/health/route";

const issuer = process.env.OIDC_ISSUER;
const suite = issuer ? describe : describe.skip;
const ORG_DEMO = "9b2f5c7e-1d3a-4e8b-a6c4-0f1e2d3c4b5a";
const BASE = "http://127.0.0.1:3000/api/v1";

async function token(client: string, secret: string) {
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: client,
      client_secret: secret,
    }),
  });
  if (!response.ok) throw new Error(`Keycloak ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}
const call = (
  path: string,
  bearer: string | null,
  init: RequestInit & { duplex?: "half" } = {},
) =>
  new Request(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      "X-Correlation-ID": "api-test",
      ...(init.headers as Record<string, string>),
    },
  });
const params = <T>(value: T) => ({ params: Promise.resolve(value) });

suite("API publique v1 avec jetons Keycloak réels", () => {
  let erp: string;
  let readonly: string;
  let other: string;
  let root: string;
  let importId: string;
  const previous = process.env.JOB_DISPATCH;

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "drizzle" });
    root = await mkdtemp(join(tmpdir(), "catamotive-api-"));
    process.env.STORAGE_DRIVER = "local";
    process.env.LOCAL_STORAGE_DIR = root;
    process.env.JOB_DISPATCH = "inline";
    [erp, readonly, other] = await Promise.all([
      token("partner-erp-demo", "partner-erp-secret-lab-only"),
      token("partner-readonly-demo", "partner-readonly-secret-lab-only"),
      token("partner-other-demo", "partner-other-secret-lab-only"),
    ]);
  });
  afterAll(async () => {
    process.env.JOB_DISPATCH = previous;
    const clients = await db
      .select({ id: users.id })
      .from(users)
      .where(like(users.email, "%@clients.catamotive.invalid"));
    const ids = clients.map((c) => c.id);
    if (ids.length) {
      await db.delete(importJobs).where(inArray(importJobs.createdBy, ids));
      await db.delete(auditEvents).where(inArray(auditEvents.userId, ids));
      await db.delete(memberships).where(inArray(memberships.userId, ids));
      await db.delete(users).where(inArray(users.id, ids));
    }
    await db
      .delete(usageRecords)
      .where(eq(usageRecords.organizationId, ORG_DEMO));
    if (root) await rm(root, { recursive: true, force: true });
    await sqlClient.end();
  });

  it("health est public", async () => {
    const response = await health.GET();
    expect(await response.json()).toMatchObject({
      status: "ok",
      dispatch: "inline",
    });
  });

  it("401 sans jeton, avec défi WWW-Authenticate et Problem Details", async () => {
    const response = await imports.GET(call("/imports", null));
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(await response.json()).toMatchObject({
      status: 401,
      correlationId: "api-test",
    });
  });

  it("401 pour un jeton falsifié (signature invalide)", async () => {
    const [header, payload, signature] = erp.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    claims.groups = [`/organizations/${ORG_DEMO}/admin`];
    const forged = [
      header,
      Buffer.from(JSON.stringify(claims)).toString("base64url"),
      signature,
    ].join(".");
    const response = await imports.GET(call("/imports", forged));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("invalid_token");
  });

  it("403 si le scope OAuth2 manque (client en lecture seule)", async () => {
    const response = await imports.POST(
      call("/imports?filename=x.csv", readonly, {
        method: "POST",
        body: "a;b\n1;2\n",
      }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain(
      'error="insufficient_scope"',
    );
    expect((await imports.GET(call("/imports", readonly))).status).toBe(200);
  });

  it("parcours complet : dépôt, mapping, traitement, rejets, export, téléchargement", async () => {
    const created = await imports.POST(
      call("/imports?filename=tarif.csv", erp, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: "SKU;Nom;Marque;Prix\nP1;Disque;Bosch;10,00\nP2;Étrier;Bosch;abc\nP3;Plaquette;Valeo;24,90\n",
      }),
    );
    expect(created.status).toBe(201);
    const body = await created.json();
    importId = body.id;
    expect(created.headers.get("location")).toBe(`/api/v1/imports/${importId}`);
    expect(body).toMatchObject({
      status: "analyzed",
      diagnostic: {
        format: "csv",
        rowCount: 3,
        headers: ["SKU", "Nom", "Marque", "Prix"],
      },
    });

    const mapped = await mapping.PUT(
      call(`/imports/${importId}/mapping`, erp, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mapping: { sku: 0, product_name: 1, brand: 2, sale_price: 3 },
        }),
      }),
      params({ importId }),
    );
    expect(mapped.status).toBe(200);
    expect((await mapped.json()).status).toBe("mapped");

    const accepted = await processing.POST(
      call(`/imports/${importId}/processing`, erp, { method: "POST" }),
      params({ importId }),
    );
    expect(accepted.status).toBe(202);
    expect((await accepted.json()).status).toBe("ready");

    const state = await (
      await oneImport.GET(
        call(`/imports/${importId}`, readonly),
        params({ importId }),
      )
    ).json();
    expect(state.counts).toMatchObject({ total: 3, invalid: 1 });

    const lines = await (
      await rejected.GET(
        call(`/imports/${importId}/rejected-lines`, readonly),
        params({ importId }),
      )
    ).json();
    expect(lines.total).toBe(1);
    expect(lines.items[0]).toMatchObject({
      sourceLine: 3,
      raw: ["P2", "Étrier", "Bosch", "abc"],
    });

    const requested = await exportsRoute.POST(
      call(`/imports/${importId}/exports`, erp, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: "woocommerce" }),
      }),
      params({ importId }),
    );
    expect(requested.status).toBe(202);
    const requestBody = await requested.json();
    expect(requestBody).toMatchObject({
      status: "ready",
      profile: "woocommerce",
    });

    const followed = await (
      await exportRequest.GET(
        call(`/export-requests/${requestBody.id}`, erp),
        params({ requestId: requestBody.id }),
      )
    ).json();
    expect(followed.links.file).toBe(
      `/api/v1/exports/${followed.exportId}/file`,
    );

    const file = await download.GET(
      call(followed.links.file.replace("/api/v1", ""), readonly),
      params({ exportId: followed.exportId, kind: "file" }),
    );
    expect(file.status).toBe(200);
    const csv = await file.text();
    expect(csv).toContain("P1");
    expect(csv).not.toContain("P2");
  });

  it("isolation : un partenaire d’une autre organisation ne voit rien", async () => {
    const response = await oneImport.GET(
      call(`/imports/${importId}`, other),
      params({ importId }),
    );
    expect(response.status).toBe(404);
    const list = await (await imports.GET(call("/imports", other))).json();
    expect(list.items.map((i: { id: string }) => i.id)).not.toContain(importId);
  });

  it("403 si l’en-tête X-Organization-ID vise une organisation non accordée", async () => {
    const response = await imports.GET(
      call("/imports", erp, {
        headers: {
          "X-Organization-ID": "3c8a1f0e-6b2d-4f7a-9e15-c2d4b6a8e0f1",
        },
      }),
    );
    expect(response.status).toBe(403);
  });
});
