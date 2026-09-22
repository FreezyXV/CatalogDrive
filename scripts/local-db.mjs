import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const root = resolve(".local");
const data = join(root, "postgres");
const bin =
  process.env.PG_BIN ||
  (existsSync("/Applications/Postgres.app/Contents/Versions/17/bin")
    ? "/Applications/Postgres.app/Contents/Versions/17/bin"
    : "");
function run(name, args, options = {}) {
  const result = spawnSync(bin ? join(bin, name) : name, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0)
    throw new Error(
      result.stderr || result.error?.message || `${name} a échoué`,
    );
  return result.stdout;
}
mkdirSync(root, { recursive: true, mode: 0o700 });
if (process.argv[2] === "stop") {
  run("pg_ctl", ["-D", data, "-m", "fast", "stop"]);
  console.log("PostgreSQL local arrêté.");
  process.exit(0);
}
if (!existsSync(join(data, "PG_VERSION"))) {
  if (existsSync(".env.local"))
    throw new Error(
      ".env.local existe déjà. Configurez votre base ou déplacez explicitement ce fichier avant db:local.",
    );
  const password = randomBytes(24).toString("hex");
  const passwordFile = join(root, "init-password");
  writeFileSync(passwordFile, password, { mode: 0o600 });
  try {
    run("initdb", [
      "-D",
      data,
      "-U",
      "catamotive",
      "--auth=scram-sha-256",
      `--pwfile=${passwordFile}`,
      "--encoding=UTF8",
      "--locale=C",
    ]);
  } finally {
    unlinkSync(passwordFile);
  }
  const common = `STORAGE_DRIVER=local\nCOOKIE_SECURE=false\n`;
  writeFileSync(
    ".env.local",
    `DATABASE_URL=postgresql://catamotive:${password}@127.0.0.1:55439/catamotive\nAPP_ORIGIN=http://127.0.0.1:3000\nLOCAL_STORAGE_DIR=.local/uploads\n${common}`,
    { mode: 0o600 },
  );
  writeFileSync(
    ".env.test",
    `DATABASE_URL=postgresql://catamotive:${password}@127.0.0.1:55439/catamotive_test\nAPP_ORIGIN=http://127.0.0.1:3100\nLOCAL_STORAGE_DIR=.local/test-uploads\n${common}`,
    { mode: 0o600 },
  );
}
const status = spawnSync(
  bin ? join(bin, "pg_ctl") : "pg_ctl",
  ["-D", data, "status"],
  { encoding: "utf8" },
);
if (status.status !== 0)
  run("pg_ctl", [
    "-D",
    data,
    "-l",
    join(root, "postgres.log"),
    "-o",
    `-p 55439 -h 127.0.0.1 -k ${root}`,
    "-w",
    "start",
  ]);
const env = readFileSync(".env.local", "utf8");
const url = new URL(env.match(/^DATABASE_URL=(.+)$/m)[1]);
for (const name of ["catamotive", "catamotive_test"]) {
  const args = ["-h", "127.0.0.1", "-p", "55439", "-U", "catamotive"];
  const options = { env: { ...process.env, PGPASSWORD: url.password } };
  const present = run(
    "psql",
    [
      ...args,
      "-d",
      "postgres",
      "-tAc",
      `SELECT 1 FROM pg_database WHERE datname = '${name}'`,
    ],
    options,
  ).trim();
  if (present !== "1") run("createdb", [...args, name], options);
}
console.log(
  "PostgreSQL local prêt sur 127.0.0.1:55439. Bases développement et test séparées ; secrets dans .env.local et .env.test.",
);
