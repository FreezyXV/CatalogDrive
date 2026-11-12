/**
 * How long-running work is executed.
 *
 * - `inline` (default): the HTTP request runs the job itself, as the
 *   Vercel pilot always did. No broker is required.
 * - `queue`: the request only records the command in the outbox; the
 *   integration worker relays it to RabbitMQ and consumes it.
 *
 * The switch is explicit so that the production deployment keeps its
 * behaviour until a hosted broker and worker exist.
 */
export type DispatchMode = "inline" | "queue";

export function dispatchMode(): DispatchMode {
  return process.env.JOB_DISPATCH === "queue" ? "queue" : "inline";
}
