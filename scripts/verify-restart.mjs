import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { config } from "dotenv";

config({ path: ".env.test", override: true, quiet: true });
if (!process.env.DATABASE_URL?.endsWith("/catamotive_test")) {
  throw new Error("Cette vérification exige la base dédiée catamotive_test.");
}
const origin = "http://127.0.0.1:3101";
let child;
async function start() {
  child = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3101",
    ],
    {
      env: { ...process.env, APP_ORIGIN: origin },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null)
      throw new Error("Le serveur de vérification n’a pas démarré.");
    try {
      if ((await fetch(origin)).ok) return;
    } catch {
      /* Await local startup. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Le serveur n’est pas prêt après 10 secondes.");
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const stopped = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await stopped;
}
let cookie;
let id;
try {
  await start();
  const registration = await fetch(`${origin}/api/auth/register`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `restart-${randomUUID()}@example.test`,
      password: randomUUID(),
      organizationName: "Test de redémarrage",
    }),
  });
  assert.equal(registration.status, 201);
  cookie = registration.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const original = Buffer.from(
    "référence;désignation\r\n00042;Pièce fictive persistante\r\n",
  );
  const uploaded = await fetch(`${origin}/api/imports`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: cookie,
      "X-File-Name": "redemarrage.csv",
    },
    body: original,
  });
  assert.equal(uploaded.status, 201);
  ({ id } = await uploaded.json());
  await stop();
  await start();
  const detail = await fetch(`${origin}/api/imports/${id}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(detail.status, 200);
  const data = await detail.json();
  assert.equal(data.diagnostic.preview[0].values[0], "00042");
  assert.equal(
    data.sha256,
    createHash("sha256").update(original).digest("hex"),
  );
  const downloaded = await fetch(`${origin}/api/imports/${id}/original`, {
    headers: { Cookie: cookie },
  });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), original);
  const deleted = await fetch(`${origin}/api/imports/${id}`, {
    method: "DELETE",
    headers: { Origin: origin, Cookie: cookie },
  });
  assert.equal(deleted.status, 200);
  await fetch(`${origin}/api/auth/logout`, {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie },
  });
  console.log(
    "PASS — session, diagnostic PostgreSQL et fichier original identique après arrêt puis redémarrage réel de Next.js.",
  );
} finally {
  await stop();
}
