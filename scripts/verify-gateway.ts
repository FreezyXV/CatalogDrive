/**
 * End-to-end proof through WSO2 API Manager:
 *   Keycloak token → WSO2 gateway (JWT + subscription + scope + throttling)
 *   → CataMotive backend (re-validates the JWT) → outbox → RabbitMQ
 *   → integration worker → result polled through the gateway.
 *
 * Prerequisites: Keycloak realm, app started with JOB_DISPATCH=queue,
 * infra/wso2-apim/deploy.sh executed.
 * Usage: NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx scripts/verify-gateway.ts
 * (the APIM lab uses its default self-signed certificate)
 */
export {};

const ISSUER =
  process.env.KC_ISSUER ?? "http://127.0.0.1:8080/realms/catamotive";
const GATEWAY =
  process.env.GATEWAY_URL ?? "https://localhost:8244/catamotive/v1";

async function token(client: string, secret: string) {
  const response = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: client,
      client_secret: secret,
    }),
  });
  return ((await response.json()) as { access_token: string }).access_token;
}
const report: Record<string, unknown> = {};
const check = (name: string, ok: boolean, detail: unknown) => {
  report[name] = { ok, detail };
  if (!ok) process.exitCode = 1;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const erp = await token("partner-erp-demo", "partner-erp-secret-lab-only");
const trial = await token(
  "partner-readonly-demo",
  "partner-readonly-secret-lab-only",
);
const other = await token(
  "partner-other-demo",
  "partner-other-secret-lab-only",
);
const api = (path: string, bearer?: string, init: RequestInit = {}) =>
  fetch(`${GATEWAY}${path}`, {
    ...init,
    headers: {
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      "X-Correlation-ID": "gateway-e2e",
      ...(init.headers as Record<string, string>),
    },
  });

check(
  "health public",
  (await api("/health")).status === 200,
  "GET /health sans jeton",
);
check(
  "sans jeton → 401",
  (await api("/imports")).status === 401,
  "GET /imports",
);
const unsubscribed = await api("/imports", other);
check(
  "client non abonné → 403 (gateway)",
  unsubscribed.status === 403,
  ((await unsubscribed.json()) as { description?: string }).description,
);
const noScope = await api("/imports?filename=x.csv", trial, {
  method: "POST",
  body: "a;b\n1;2\n",
});
check(
  "scope manquant → 403 (gateway)",
  noScope.status === 403,
  await noScope.text(),
);

const created = await api("/imports?filename=gateway-demo.csv", erp, {
  method: "POST",
  headers: { "Content-Type": "application/octet-stream" },
  body:
    "SKU;Désignation;Marque;Prix\n" +
    "G1;Filtre à huile;Bosch;12,50\n" +
    "G2;Plaquettes;Brembo;prix?\n" +
    "G3;Disque;Brembo;48,00\n",
});
const imported = (await created.json()) as { id: string; status: string };
check("dépôt via gateway → 201", created.status === 201, imported.status);

await api(`/imports/${imported.id}/mapping`, erp, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    mapping: { sku: 0, product_name: 1, brand: 2, sale_price: 3 },
  }),
});
const accepted = await api(`/imports/${imported.id}/processing`, erp, {
  method: "POST",
});
const acceptedBody = (await accepted.json()) as {
  status: string;
  route: string;
};
check(
  "traitement asynchrone → 202 + route calculée",
  accepted.status === 202 && acceptedBody.route === "import.process.text",
  acceptedBody,
);

let state = { status: "queued", counts: null as unknown };
for (let i = 0; i < 40 && !["ready", "failed"].includes(state.status); i++) {
  await sleep(500);
  state = (await (
    await api(`/imports/${imported.id}`, erp)
  ).json()) as typeof state;
}
check("worker RabbitMQ → import prêt", state.status === "ready", state.counts);

const rejected = (await (
  await api(`/imports/${imported.id}/rejected-lines`, erp)
).json()) as {
  total: number;
  items: { sourceLine: number; issues: { code: string }[] }[];
};
check(
  "lignes rejetées exposées",
  rejected.total === 1,
  rejected.items.map((l) => ({
    line: l.sourceLine,
    codes: l.issues.map((i) => i.code),
  })),
);

const exportAccepted = await api(`/imports/${imported.id}/exports`, erp, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ profile: "prestashop" }),
});
const request = (await exportAccepted.json()) as { id: string; route: string };
check(
  "export routé vers la file CMS",
  exportAccepted.status === 202 &&
    request.route === "export.generate.prestashop",
  request.route,
);
let exportState = { status: "queued", links: {} as Record<string, string> };
for (
  let i = 0;
  i < 40 && !["ready", "failed"].includes(exportState.status);
  i++
) {
  await sleep(500);
  exportState = (await (
    await api(`/export-requests/${request.id}`, erp)
  ).json()) as typeof exportState;
}
const file = await api(
  exportState.links.file?.replace("/api/v1", "") ?? "/missing",
  erp,
);
const csv = await file.text();
check(
  "export prêt et téléchargeable via gateway",
  exportState.status === "ready" && file.status === 200 && csv.includes("G1"),
  csv.split("\r\n").slice(0, 2),
);

// Throttling: PartnerTrial is on CataMotiveBronze (5 requests/minute).
const codes: number[] = [];
for (let i = 0; i < 15; i++) {
  codes.push((await api("/imports", trial)).status);
  await sleep(200);
}
check("throttling Bronze → 429", codes.includes(429), codes.join(" "));

console.log(JSON.stringify(report, null, 2));
