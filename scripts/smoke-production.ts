/**
 * Production smoke test, run by GitHub Actions after each successful
 * production deployment (and on demand):
 *   home page → health → register → signed upload to object storage →
 *   diagnostic → mapping → processing → export → download → delete import.
 * It proves that the database (Neon), the session, the RBAC, the object
 * storage and the processing pipeline work together on the real deployment.
 * The temporary account is a throw-away `smoke-…@example.test` organization;
 * its import and files are deleted at the end.
 *
 * Usage: APP_URL=https://catalog-drive.vercel.app node --import tsx scripts/smoke-production.ts
 */
import { DEFAULT_RULES } from "../src/domain/catalog";
import { defaultExportConfig } from "../src/domain/exports";

const APP = (process.env.APP_URL ?? "https://catalog-drive.vercel.app").replace(
  /\/$/,
  "",
);
let cookie = "";
const step = (name: string, ok: boolean, detail: unknown = "") => {
  console.log(
    `${ok ? "OK  " : "FAIL"} ${name}${detail ? ` · ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`,
  );
  if (!ok) process.exit(1);
};
async function call(path: string, init: RequestInit = {}) {
  const response = await fetch(`${APP}${path}`, {
    ...init,
    redirect: "manual",
    headers: {
      Origin: APP,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers as Record<string, string>),
    },
  });
  const set = response.headers
    .getSetCookie()
    .find((c) => c.startsWith("catamotive_session="));
  if (set) cookie = set.split(";")[0];
  return response;
}
const json = async (response: Response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
};

const home = await call("/");
step("page d'accueil", home.status === 200, home.status);
const health = await json(await call("/api/v1/health"));
step("santé de l'API", health.status === "ok", health);

const email = `smoke-${Date.now()}@example.test`;
const registered = await call("/api/auth/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email,
    password: `Smoke-${crypto.randomUUID()}`,
    organizationName: "Smoke test (automatique)",
  }),
});
step(
  "inscription (écriture PostgreSQL)",
  registered.status === 201 && Boolean(cookie),
  registered.status,
);
const dashboard = await call("/dashboard");
step(
  "tableau de bord (session + rôle)",
  dashboard.status === 200 &&
    (await dashboard.text()).includes("Administrateur"),
  dashboard.status,
);

const csv = Buffer.from(
  "SKU;Désignation;Marque;Prix\nSMK1;Disque de frein;Bosch;48,00\nSMK2;Plaquettes;Valeo;24,90\n",
);
const init = await call("/api/uploads", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ bytes: csv.length }),
});
let importId: string;
if (init.status === 201) {
  const upload = await json(init);
  const put = await fetch(upload.url, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: csv,
  });
  step(
    "dépôt vers le stockage objet (URL signée)",
    put.ok,
    put.ok
      ? put.status
      : `${put.status} ${new URL(upload.url).host} ${(await put.text()).slice(0, 500)}`,
  );
  const created = await json(
    await call("/api/imports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: upload.key,
        filename: "smoke-test.csv",
      }),
    }),
  );
  importId = created.id;
} else {
  step("stockage local (pas d'URL signée)", init.status === 409, init.status);
  const created = await json(
    await call("/api/imports", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-File-Name": "smoke-test.csv",
      },
      body: csv,
    }),
  );
  importId = created.id;
}
step("import créé et diagnostiqué", Boolean(importId), importId);

const catalog = (body: unknown) =>
  call(`/api/imports/${importId}/catalog`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const mapped = await catalog({
  action: "mapping",
  mapping: { sku: 0, product_name: 1, brand: 2, sale_price: 3 },
  rules: DEFAULT_RULES,
  options: {},
});
step(
  "mapping enregistré",
  mapped.ok,
  mapped.ok ? mapped.status : await json(mapped),
);
const processed = await json(await catalog({ action: "process" }));
step("traitement lancé", processed.ok === true, processed);
let state: { job?: { status?: string; counts?: unknown } } = {};
for (let i = 0; i < 30; i++) {
  state = await json(await call(`/api/imports/${importId}/catalog`));
  if (["ready", "failed"].includes(state.job?.status ?? "")) break;
  await new Promise((r) => setTimeout(r, 2000));
}
step(
  "normalisation terminée",
  state.job?.status === "ready",
  state.job?.counts,
);

const exported = await json(
  await catalog({ action: "export", config: defaultExportConfig("generic") }),
);
step(
  "export généré",
  Boolean(exported.export?.id),
  exported.export?.rowCount ?? exported,
);
const file = await call(`/api/exports/${exported.export.id}/file`);
const location = file.headers.get("location");
const content = location
  ? await (await fetch(location)).text()
  : await file.text();
step("export téléchargé", content.includes("SMK1"), `${content.length} octets`);

const removed = await call(`/api/imports/${importId}`, { method: "DELETE" });
step("import et fichiers supprimés", removed.ok, removed.status);
console.log(`Smoke test réussi sur ${APP}`);
