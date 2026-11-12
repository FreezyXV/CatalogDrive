import { EXCHANGES } from "./topology";
import type { IntegrationMessage } from "./messages";

/**
 * Content-Based Router (Enterprise Integration Patterns, Hohpe & Woolf).
 *
 * Producers never choose a queue. They describe *what* happened or *what*
 * must be done; this single component reads the message content and decides
 * where it goes. Adding a target (e.g. a Magento profile) or a new reader
 * family changes this function and the topology, not the producers.
 *
 * Rules:
 * - import.process   → by source format: delimited text vs spreadsheet.
 *   Spreadsheets (XLSX/XLS/ODS) are decompressed and parsed in memory-heavier
 *   readers; isolating them lets ops scale or throttle them separately.
 * - export.generate  → by target profile. CMS profiles (WooCommerce,
 *   PrestaShop, Shopify) go to q.export.cms (pre-checks of mandatory columns),
 *   generic/custom files to q.export.file.
 * - events           → by event type on catamotive.events.
 *
 * An unknown value produces a key no queue is bound to: RabbitMQ then sends
 * the message to the alternate exchange (q.unroutable) instead of dropping it.
 */
export type Route = { exchange: string; routingKey: string };

const TEXT_FORMATS = new Set(["csv"]);
const SPREADSHEET_FORMATS = new Set(["xlsx", "xls", "ods"]);

export function sourceFamily(format: string) {
  if (TEXT_FORMATS.has(format)) return "text";
  if (SPREADSHEET_FORMATS.has(format)) return "spreadsheet";
  return "unknown";
}

export function routeMessage(message: IntegrationMessage): Route {
  switch (message.type) {
    case "import.process":
      return {
        exchange: EXCHANGES.commands,
        routingKey: `import.process.${sourceFamily(message.sourceFormat)}`,
      };
    case "export.generate":
      return {
        exchange: EXCHANGES.commands,
        routingKey: `export.generate.${message.profile}`,
      };
    case "import.lines.rejected":
    case "import.processing.completed":
    case "import.processing.failed":
    case "export.completed":
    case "export.failed":
      return { exchange: EXCHANGES.events, routingKey: message.type };
  }
}
