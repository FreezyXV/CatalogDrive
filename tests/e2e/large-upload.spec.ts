import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("50 Mo : dépôt CSV proche du plafond, diagnostic et suppression", async ({
  page,
}) => {
  const password = "mot-de-passe-e2e-local";
  await page.goto("/inscription");
  await page.getByLabel("Nom de l’organisation").fill("Atelier 50 Mo");
  await page.getByLabel("Adresse email").fill(`${randomUUID()}@example.test`);
  await page.getByLabel("Mot de passe").fill(password);
  await page
    .getByRole("button", { name: "Créer mon espace", exact: true })
    .click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page
    .getByRole("link", { name: "Nouvel import", exact: true })
    .last()
    .click();
  await expect(
    page.getByText("50 Mo maximum par fichier déposé"),
  ).toBeVisible();
  const row = `REF;${"A".repeat(1950)}\n`;
  const buffer = Buffer.from(`ref;nom\n${row.repeat(25_000)}`);
  expect(buffer.length).toBeGreaterThan(45_000_000);
  await page.getByLabel("Fichier catalogue fournisseur").setInputFiles({
    name: "grand-catalogue.csv",
    mimeType: "text/csv",
    buffer,
  });
  await page.getByRole("button", { name: "Analyser le fichier" }).click();
  await expect(
    page.getByRole("heading", { name: "Diagnostic du fichier" }),
  ).toBeVisible();
  const id = page.url().split("/").pop()!;
  await expect(page.getByText("25 000")).toBeVisible();
  const deleted = await page.request.delete(`/api/imports/${id}`, {
    headers: { Origin: "http://127.0.0.1:3100" },
  });
  expect(deleted.ok()).toBe(true);
});
