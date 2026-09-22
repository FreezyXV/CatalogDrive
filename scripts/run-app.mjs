import { spawn } from "node:child_process";
const mode = process.argv[2] ?? "start";
const extra = process.argv.slice(3);
const app = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    mode,
    ...(mode === "dev" ? ["--webpack"] : []),
    "--hostname",
    process.env.APP_HOST ?? "127.0.0.1",
    ...extra,
  ],
  { stdio: "inherit", env: process.env },
);
const worker = spawn(
  process.execPath,
  ["--import", "tsx", "scripts/worker.ts"],
  { stdio: "inherit", env: process.env },
);
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  app.kill("SIGTERM");
  worker.kill("SIGTERM");
  const timer = setTimeout(() => {
    app.kill("SIGKILL");
    worker.kill("SIGKILL");
  }, 10000);
  timer.unref();
  Promise.all([
    new Promise((r) => (app.exitCode !== null ? r() : app.once("exit", r))),
    new Promise((r) =>
      worker.exitCode !== null ? r() : worker.once("exit", r),
    ),
  ]).then(() => process.exit(code));
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
app.on("exit", (code) => stop(code ?? 1));
worker.on("exit", (code) => {
  if (!stopping) stop(code ?? 1);
});
