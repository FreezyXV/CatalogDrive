import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import yazl from "yazl";
const origin = "http://127.0.0.1:3100";
const password = "mot-de-passe-e2e-local";
async function makeZip(files: { name: string; body: Buffer }[]) {
  const zip = new yazl.ZipFile();
  for (const file of files) zip.addBuffer(file.body, file.name);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function signup(page: Page, name: string) {
  const email = `${randomUUID()}@example.test`;
  await page.goto("/inscription");
  await page.getByLabel("Nom de l’organisation").fill(name);
  await page.getByLabel("Adresse email").fill(email);
  await page.getByLabel("Mot de passe").fill(password);
  await page
    .getByRole("button", { name: "Créer mon espace", exact: true })
    .click();
  await expect(page).toHaveURL(/\/dashboard$/);
  return email;
}
async function apiSignup(request: APIRequestContext) {
  const response = await request.post("/api/auth/register", {
    headers: { Origin: origin },
    data: {
      email: `${randomUUID()}@example.test`,
      password,
      organizationName: "Organisation API",
    },
  });
  expect(response.status()).toBe(201);
}
test("ZIP de deux CSV → deux imports visibles → archive d’origine téléchargeable", async ({
  page,
}) => {
  await signup(page, "Atelier ZIP");
  await page
    .getByRole("link", { name: "Nouvel import", exact: true })
    .last()
    .click();
  const archive = await makeZip([
    {
      name: "fournisseur-a/alpha.csv",
      body: Buffer.from("ref;nom\nA1;Filtre\n"),
    },
    {
      name: "fournisseur-b/beta.csv",
      body: Buffer.from("ref;nom\nB2;Frein\n"),
    },
  ]);
  await page.getByLabel("Fichier catalogue fournisseur").setInputFiles({
    name: "fournisseurs.zip",
    mimeType: "application/zip",
    buffer: archive,
  });
  await page.getByRole("button", { name: "Analyser le fichier" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText("fournisseur-a/alpha.csv")).toBeVisible();
  await expect(page.getByText("fournisseur-b/beta.csv")).toBeVisible();
  await page.getByRole("link", { name: "Ouvrir alpha.csv" }).click();
  await expect(page.getByText("A1", { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("link", { name: "Télécharger l’archive ZIP d’origine" })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("fournisseurs.zip");
  expect(await readFile((await download.path())!)).toEqual(archive);
});
test("compte → import CSV → diagnostic → original identique → reconnexion → suppression", async ({
  page,
}) => {
  const email = await signup(page, "Atelier de vérification");
  await expect(page.getByText("Votre atelier est prêt.")).toBeVisible();
  await page
    .getByRole("link", { name: "Nouvel import", exact: true })
    .last()
    .click();
  const original = Buffer.from(
    '\ufeffRéférence;Désignation;Prix\r\n00123;"Pièce ; de démonstration";12,50\r\n00456;"Texte\nsur deux lignes";=1+1\r\n00789;<script>alert(1)</script>;4\r\n',
  );
  await page.getByLabel("Fichier catalogue fournisseur").setInputFiles({
    name: "fournisseur-échantillon.csv",
    mimeType: "text/csv",
    buffer: original,
  });
  await page.getByRole("button", { name: "Analyser le fichier" }).click();
  await expect(
    page.getByRole("heading", { name: "Diagnostic du fichier" }),
  ).toBeVisible();
  const importURL = page.url();
  const id = importURL.split("/").pop()!;
  await expect(page.getByText("00123", { exact: true })).toBeVisible();
  await expect(
    page.getByText("<script>alert(1)</script>", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("=1+1", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Analyse terminée · fichier lisible"),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/diagnostic-desktop.png",
    fullPage: true,
  });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Télécharger l’original" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("fournisseur-échantillon.csv");
  expect(await readFile((await download.path())!)).toEqual(original);
  const json = await (await page.request.get(`/api/imports/${id}`)).json();
  expect(json.sha256).toBe(createHash("sha256").update(original).digest("hex"));
  await page.getByRole("button", { name: "Se déconnecter" }).click();
  await expect(page).toHaveURL(/\/connexion$/);
  expect((await page.request.get(`/api/imports/${id}/original`)).status()).toBe(
    401,
  );
  await page.getByLabel("Adresse email").fill(email);
  await page.getByLabel("Mot de passe").fill(password);
  await page.getByRole("button", { name: "Me connecter", exact: true }).click();
  await expect(
    page.getByRole("link", { name: /fournisseur-échantillon.csv CSV/ }),
  ).toBeVisible();
  await page.reload();
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  await page.goto(importURL);
  await page.getByRole("button", { name: "Supprimer cet import" }).click();
  await page.getByRole("button", { name: "Confirmer la suppression" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  expect((await page.request.get(`/api/imports/${id}`)).status()).toBe(404);
  expect((await page.request.get(`/api/imports/${id}/original`)).status()).toBe(
    404,
  );
});
test("deux organisations ne peuvent lire, télécharger ou supprimer leurs imports respectifs", async ({
  browser,
  page,
}) => {
  await signup(page, "Organisation privée A");
  const response = await page.request.post("/api/imports", {
    headers: {
      Origin: origin,
      "X-File-Name": "prive.csv",
      "Content-Type": "application/octet-stream",
    },
    data: Buffer.from("ref;nom\n001;Privé\n"),
  });
  expect(response.status()).toBe(201);
  const { id } = await response.json();
  const second = await browser.newContext({ baseURL: origin });
  const pageB = await second.newPage();
  await signup(pageB, "Organisation privée B");
  expect((await second.request.get(`/api/imports/${id}`)).status()).toBe(404);
  expect(
    (await second.request.get(`/api/imports/${id}/original`)).status(),
  ).toBe(404);
  expect(
    (
      await second.request.delete(`/api/imports/${id}`, {
        headers: { Origin: origin },
      })
    ).status(),
  ).toBe(404);
  await pageB.goto(`/imports/${id}`);
  await expect(
    pageB.getByRole("heading", { name: "Page introuvable." }),
  ).toBeVisible();
  expect((await page.request.get(`/api/imports/${id}/original`)).status()).toBe(
    200,
  );
  expect(
    (
      await page.request.delete(`/api/imports/${id}`, {
        headers: { Origin: origin },
      })
    ).status(),
  ).toBe(200);
  await second.close();
});
test("refus explicites : origine, session, XLSX, binaire, CSV cassé, taille et limites JSON", async ({
  request,
}) => {
  expect(
    (
      await request.post("/api/imports", {
        headers: { Origin: origin, "X-File-Name": "a.csv" },
        data: "a;b\n1;2",
      })
    ).status(),
  ).toBe(401);
  expect(
    (
      await request.post("/api/auth/register", {
        headers: { Origin: "https://attacker.example" },
        data: {},
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post("/api/auth/register", {
        headers: { Origin: origin, "Content-Type": "application/json" },
        data: "x".repeat(5000),
      })
    ).status(),
  ).toBe(413);
  await apiSignup(request);
  for (const [name, content] of [
    ["file.xlsx", "fake"],
    ["file.csv", "PK\x03\x04"],
    ["broken.csv", 'a;b\n1;"open'],
    ["empty.csv", ""],
    ["../path.csv", "a;b\n1;2"],
  ]) {
    const response = await request.post("/api/imports", {
      headers: { Origin: origin, "X-File-Name": encodeURIComponent(name) },
      data: Buffer.from(content),
    });
    expect(response.status()).toBe(422);
    expect((await response.json()).error).toBeTruthy();
  }
  expect(
    (
      await request.post("/api/imports", {
        headers: { Origin: origin, "X-File-Name": "large.csv" },
        data: Buffer.alloc(50_000_001, "a"),
      })
    ).status(),
  ).toBe(413);
  expect(
    (
      await request.post("/api/imports", {
        headers: { Origin: origin, "X-File-Name": "%zz" },
        data: "a;b\n1;2",
      })
    ).status(),
  ).toBe(400);
});
test("un CSV irrégulier affiche ses avertissements et reste intact", async ({
  page,
}) => {
  await signup(page, "Atelier structure");
  await page.goto("/imports/new");
  await page.getByLabel("Fichier catalogue fournisseur").setInputFiles({
    name: "irregulier.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("ref;ref;\n001;2;3;EXTRA\n002;4\n"),
  });
  await page.getByRole("button", { name: "Analyser le fichier" }).click();
  await expect(
    page.getByText("Analyse terminée · structure à vérifier"),
  ).toBeVisible();
  await expect(page.getByText(/2 ligne\(s\) ont un nombre/)).toBeVisible();
  await expect(page.getByText("EXTRA", { exact: true })).toBeVisible();
});
test("parcours mobile : inscription, dépôt et lecture sans débordement de page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signup(page, "Atelier mobile");
  await page
    .getByRole("link", { name: "Nouvel import", exact: true })
    .last()
    .click();
  await page
    .getByLabel("Fichier catalogue fournisseur")
    .setInputFiles("public/demo/fournisseur-demo.csv");
  await page.getByRole("button", { name: "Analyser le fichier" }).click();
  await expect(
    page.getByRole("heading", { name: "Diagnostic du fichier" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/diagnostic-mobile.png",
    fullPage: true,
  });
});

test("parcours métier complet : mapping → règles → validation manuelle → catalogue et rapport", async ({
  page,
}) => {
  await signup(page, "Atelier parcours complet");
  await page.goto("/imports/new");
  await page.getByLabel("Fichier catalogue fournisseur").setInputFiles({
    name: "catalogue-complet.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "Référence;Désignation;Marque;Prix;Stock\nA001;Filtre;Bosch;12,50;4\nA-002;Plaquette;Bosch;19,90;2\nA003;Invalide;Bosch;prix;1\n",
    ),
  });
  await page.getByRole("button", { name: "Analyser le fichier" }).click();
  await page.getByRole("link", { name: /Configurer le mapping/ }).click();
  await expect(
    page.getByRole("heading", { name: "Correspondance des colonnes" }),
  ).toBeVisible();
  await page
    .getByPlaceholder("Optionnel · ex. Fournisseur Martin")
    .fill("Fournisseur E2E");
  await page.getByRole("button", { name: "Lancer le traitement" }).click();
  await expect(
    page.getByRole("heading", { name: "Rapport et validation" }),
  ).toBeVisible();
  await expect(page.getByText("1", { exact: true }).first()).toBeVisible();
  const ambiguous = page.locator("article").filter({ hasText: "A-002" });
  await ambiguous.getByRole("button", { name: "Conserver" }).click();
  await expect(ambiguous.getByText("valid", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Configurer l’export" }).click();
  await expect(
    page.getByRole("heading", { name: "Export prêt pour votre destination" }),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Créer et télécharger" }).click();
  const catalog = await downloadPromise;
  const catalogBytes = await readFile((await catalog.path())!);
  expect(catalogBytes.toString("utf8")).toContain("A001");
  expect(catalogBytes.toString("utf8")).toContain("A-002");
  expect(catalogBytes.toString("utf8")).not.toContain("A003");
  await expect(page.getByRole("cell", { name: "CSV normalisé" })).toBeVisible();
  const reportPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Rapport", exact: true }).click();
  const report = await reportPromise;
  expect((await readFile((await report.path())!)).toString("utf8")).toContain(
    "transformation",
  );
  await page.goto("/templates");
  await expect(page.getByText("Fournisseur E2E")).toBeVisible();
});

test("un classeur XLSX réel conserve ses feuilles, ses zéros et ses formules comme texte", async ({
  page,
}) => {
  await signup(page, "Atelier XLSX");
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Notice").addRow(["Informations fournisseur"]);
  const catalog = workbook.addWorksheet("Catalogue");
  catalog.addRow(["Préambule"]);
  catalog.addRow(["Référence", "Désignation", "Prix"]);
  const row = catalog.addRow([
    123,
    "Filtre XLSX",
    { formula: "1+1", result: 2 },
  ]);
  row.getCell(1).numFmt = "00000";
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  await page.goto("/imports/new");
  await page.getByLabel("Fichier catalogue fournisseur").setInputFiles({
    name: "catalogue.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer,
  });
  await page.getByRole("button", { name: "Analyser le fichier" }).click();
  await expect(page.getByText("XLSX", { exact: true })).toBeVisible();
  await expect(page.getByText("00123", { exact: true })).toBeVisible();
  await expect(page.getByText("=1+1", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: /Configurer le mapping/ }).click();
  await expect(page.getByLabel("Feuille")).toHaveValue("Catalogue");
});
