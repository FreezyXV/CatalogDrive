/**
 * RabbitMQ topology, declared as data so that it can be reviewed,
 * tested and asserted identically by every process (idempotent declares).
 *
 *   producers ──► catamotive.commands (topic) ──► q.import.text
 *                         │                   ├─► q.import.spreadsheet
 *                         │                   ├─► q.export.cms
 *                         │                   └─► q.export.file
 *                         └─ unroutable ─► catamotive.unroutable ─► q.unroutable
 *
 *   workers   ──► catamotive.events (topic)   ──► q.rejected-lines   (invalid message channel)
 *                                             └─► q.notifications
 *
 *   any queue ── rejected / delivery limit ──► catamotive.dlx ──► q.dead-letter
 */
export const EXCHANGES = {
  commands: "catamotive.commands",
  events: "catamotive.events",
  deadLetter: "catamotive.dlx",
  unroutable: "catamotive.unroutable",
} as const;

export const QUEUES = {
  importText: "q.import.text",
  importSpreadsheet: "q.import.spreadsheet",
  exportCms: "q.export.cms",
  exportFile: "q.export.file",
  rejectedLines: "q.rejected-lines",
  notifications: "q.notifications",
  deadLetter: "q.dead-letter",
  unroutable: "q.unroutable",
} as const;

/** Redeliveries tolerated before RabbitMQ dead-letters a poison message. */
export const DELIVERY_LIMIT = 3;

export type ExchangeDeclaration = {
  name: string;
  type: "topic" | "fanout";
  alternateExchange?: string;
};
export type QueueDeclaration = {
  name: string;
  /** Quorum queues are replicated (Raft) and support x-delivery-limit. */
  kind: "quorum" | "classic";
  deadLetter: boolean;
  bindings: { exchange: string; pattern: string }[];
};

export const exchanges: ExchangeDeclaration[] = [
  {
    name: EXCHANGES.commands,
    type: "topic",
    alternateExchange: EXCHANGES.unroutable,
  },
  {
    name: EXCHANGES.events,
    type: "topic",
    alternateExchange: EXCHANGES.unroutable,
  },
  { name: EXCHANGES.deadLetter, type: "topic" },
  { name: EXCHANGES.unroutable, type: "fanout" },
];

export const queues: QueueDeclaration[] = [
  {
    name: QUEUES.importText,
    kind: "quorum",
    deadLetter: true,
    bindings: [
      { exchange: EXCHANGES.commands, pattern: "import.process.text" },
    ],
  },
  {
    name: QUEUES.importSpreadsheet,
    kind: "quorum",
    deadLetter: true,
    bindings: [
      { exchange: EXCHANGES.commands, pattern: "import.process.spreadsheet" },
    ],
  },
  {
    name: QUEUES.exportCms,
    kind: "quorum",
    deadLetter: true,
    bindings: ["woocommerce", "prestashop", "shopify"].map((profile) => ({
      exchange: EXCHANGES.commands,
      pattern: `export.generate.${profile}`,
    })),
  },
  {
    name: QUEUES.exportFile,
    kind: "quorum",
    deadLetter: true,
    bindings: ["generic", "custom"].map((profile) => ({
      exchange: EXCHANGES.commands,
      pattern: `export.generate.${profile}`,
    })),
  },
  {
    name: QUEUES.rejectedLines,
    kind: "quorum",
    deadLetter: true,
    bindings: [
      { exchange: EXCHANGES.events, pattern: "import.lines.rejected" },
    ],
  },
  {
    name: QUEUES.notifications,
    kind: "quorum",
    deadLetter: true,
    bindings: [
      { exchange: EXCHANGES.events, pattern: "import.processing.*" },
      { exchange: EXCHANGES.events, pattern: "export.*" },
    ],
  },
  {
    name: QUEUES.deadLetter,
    kind: "classic",
    deadLetter: false,
    bindings: [{ exchange: EXCHANGES.deadLetter, pattern: "#" }],
  },
  {
    name: QUEUES.unroutable,
    kind: "classic",
    deadLetter: false,
    bindings: [{ exchange: EXCHANGES.unroutable, pattern: "" }],
  },
];

export function queueArguments(queue: QueueDeclaration) {
  const args: Record<string, unknown> = {};
  if (queue.kind === "quorum") {
    args["x-queue-type"] = "quorum";
    args["x-delivery-limit"] = DELIVERY_LIMIT;
  }
  if (queue.deadLetter) args["x-dead-letter-exchange"] = EXCHANGES.deadLetter;
  return args;
}

/** AMQP topic matching: `*` = exactly one word, `#` = zero or more words. */
export function topicMatches(pattern: string, routingKey: string) {
  const p = pattern.split(".");
  const k = routingKey.split(".");
  const match = (i: number, j: number): boolean => {
    if (i === p.length) return j === k.length;
    if (p[i] === "#") {
      for (let skip = j; skip <= k.length; skip++)
        if (match(i + 1, skip)) return true;
      return false;
    }
    if (j === k.length) return false;
    return (p[i] === "*" || p[i] === k[j]) && match(i + 1, j + 1);
  };
  return match(0, 0);
}

/** Queues that would receive a message published on `exchange` with `routingKey`. */
export function resolveQueues(exchange: string, routingKey: string) {
  const declaration = exchanges.find((e) => e.name === exchange);
  const matched = queues
    .filter((queue) =>
      queue.bindings.some(
        (binding) =>
          binding.exchange === exchange &&
          (declaration?.type === "fanout" ||
            topicMatches(binding.pattern, routingKey)),
      ),
    )
    .map((queue) => queue.name);
  if (!matched.length && declaration?.alternateExchange)
    return resolveQueues(declaration.alternateExchange, routingKey);
  return matched;
}
