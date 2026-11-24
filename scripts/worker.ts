import { config } from "dotenv";
config({
  path: process.env.APP_ENV === "test" ? ".env.test" : ".env.local",
  quiet: true,
});
// Queue mode: RabbitMQ consumers replace PostgreSQL polling.
if (process.env.JOB_DISPATCH === "queue") {
  await import("./integration-worker");
  process.exit(0);
}
const { runNextJob } = await import("../src/server/catalog");
const { runNextSync } = await import("../src/server/stores/sync");
const { sqlClient } = await import("../src/server/db");
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
console.log("Worker PostgreSQL CataMotive prêt.");
while (!stopping) {
  try {
    if (!(await runNextJob()) && !(await runNextSync()))
      await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch {
    console.error("Worker indisponible : vérifiez PostgreSQL.");
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
await sqlClient.end();
