import { randomUUID } from "node:crypto";
import {
  DELIVERY_LIMIT,
  exchanges,
  queueArguments,
  queues,
  resolveQueues,
} from "./topology";

/**
 * Port between the application and the message broker. The production
 * adapter is RabbitMQ (AMQP 0-9-1); the in-memory adapter reproduces the
 * same routing, acknowledgement and dead-lettering semantics so that the
 * handlers can be tested without a broker.
 */
export type OutgoingMessage = {
  exchange: string;
  routingKey: string;
  body: unknown;
  messageId: string;
  correlationId: string;
  type: string;
  headers?: Record<string, string | number>;
};

export type Delivery = {
  body: Buffer;
  messageId: string;
  correlationId: string;
  type: string;
  routingKey: string;
  redelivered: boolean;
  deliveryCount: number;
  headers: Record<string, unknown>;
};

/**
 * What the consumer decided:
 * - ack:     processed (or duplicate) — remove from the queue;
 * - retry:   transient failure — requeue, dead-lettered after the delivery limit;
 * - reject:  permanently invalid — dead-letter immediately.
 */
export type Outcome = "ack" | "retry" | "reject";
export type Handler = (delivery: Delivery) => Promise<Outcome>;

export interface MessageBroker {
  /** Resolves only once the broker has confirmed the message (publisher confirms). */
  publish(message: OutgoingMessage): Promise<void>;
  consume(queue: string, handler: Handler, prefetch?: number): Promise<void>;
  close(): Promise<void>;
}

export class AmqpBroker implements MessageBroker {
  private connected = true;

  private constructor(
    private connection: import("amqplib").ChannelModel,
    private publisher: import("amqplib").ConfirmChannel,
  ) {}

  get healthy() {
    return this.connected;
  }

  private watch(
    channel: import("amqplib").Channel | import("amqplib").ChannelModel,
  ) {
    const unhealthy = () => {
      this.connected = false;
    };
    channel.on("error", unhealthy);
    channel.on("close", unhealthy);
  }

  static async connect(url: string) {
    const amqp = await import("amqplib");
    const endpoint = new URL(url);
    if (!endpoint.searchParams.has("heartbeat"))
      endpoint.searchParams.set("heartbeat", "15");
    const connection = await amqp.connect(endpoint.toString(), {
      clientProperties: { connection_name: "catamotive" },
      timeout: 10_000,
    });
    // EventEmitter errors can arrive before the confirm channel is created.
    connection.on("error", () => undefined);
    try {
      const publisher = await connection.createConfirmChannel();
      const broker = new AmqpBroker(connection, publisher);
      broker.watch(connection);
      broker.watch(publisher);
      await broker.assertTopology();
      return broker;
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }
  }

  /** Declarations are idempotent: every process can assert the same topology. */
  async assertTopology() {
    for (const exchange of exchanges)
      await this.publisher.assertExchange(exchange.name, exchange.type, {
        durable: true,
        arguments: exchange.alternateExchange
          ? { "alternate-exchange": exchange.alternateExchange }
          : {},
      });
    for (const queue of queues) {
      await this.publisher.assertQueue(queue.name, {
        durable: true,
        arguments: queueArguments(queue),
      });
      for (const binding of queue.bindings)
        await this.publisher.bindQueue(
          queue.name,
          binding.exchange,
          binding.pattern,
        );
    }
  }

  async publish(message: OutgoingMessage) {
    await new Promise<void>((resolve, reject) => {
      this.publisher.publish(
        message.exchange,
        message.routingKey,
        Buffer.from(JSON.stringify(message.body)),
        {
          persistent: true,
          contentType: "application/json",
          messageId: message.messageId,
          correlationId: message.correlationId,
          type: message.type,
          appId: "catamotive",
          timestamp: Math.floor(Date.now() / 1000),
          headers: message.headers,
        },
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }

  async consume(queue: string, handler: Handler, prefetch = 1) {
    const channel = await this.connection.createChannel();
    this.watch(channel);
    // One unacknowledged message per consumer: imports are long-running,
    // so fair dispatch matters more than throughput.
    await channel.prefetch(prefetch);
    await channel.consume(queue, async (message) => {
      if (!message) {
        this.connected = false;
        return;
      }
      const headers = message.properties.headers ?? {};
      const outcome = await handler({
        body: message.content,
        messageId: String(message.properties.messageId ?? ""),
        correlationId: String(message.properties.correlationId ?? ""),
        type: String(message.properties.type ?? ""),
        routingKey: message.fields.routingKey,
        redelivered: message.fields.redelivered,
        deliveryCount: Number(headers["x-delivery-count"] ?? 0),
        headers,
      }).catch(() => "retry" as const);
      try {
        if (outcome === "ack") channel.ack(message);
        else channel.nack(message, false, outcome === "retry");
      } catch {
        // A closed channel requeues unacknowledged messages at the broker.
        this.connected = false;
      }
    });
  }

  async close() {
    await this.publisher.close().catch(() => undefined);
    await this.connection.close().catch(() => undefined);
  }
}

type Stored = Omit<Delivery, "deliveryCount" | "redelivered"> & {
  deliveries: number;
};

/**
 * Deterministic in-memory broker for tests. It applies the same topology
 * (topic matching, alternate exchange, dead-letter exchange, delivery limit)
 * as RabbitMQ, synchronously via `drain()`.
 */
export class InMemoryBroker implements MessageBroker {
  readonly queues = new Map<string, Stored[]>();
  private handlers = new Map<string, Handler>();
  readonly published: OutgoingMessage[] = [];
  failNextPublish = false;

  constructor() {
    for (const queue of queues) this.queues.set(queue.name, []);
  }

  async publish(message: OutgoingMessage) {
    if (this.failNextPublish) {
      this.failNextPublish = false;
      throw new Error("Broker indisponible (simulation)");
    }
    this.published.push(message);
    for (const name of resolveQueues(message.exchange, message.routingKey))
      this.queues.get(name)!.push({
        body: Buffer.from(JSON.stringify(message.body)),
        messageId: message.messageId,
        correlationId: message.correlationId,
        type: message.type,
        routingKey: message.routingKey,
        headers: { ...message.headers },
        deliveries: 0,
      });
  }

  async consume(queue: string, handler: Handler) {
    this.handlers.set(queue, handler);
  }

  /** Delivers every pending message until all handled queues are empty. */
  async drain() {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [queue, handler] of this.handlers) {
        const pending = this.queues.get(queue)!;
        const message = pending.shift();
        if (!message) continue;
        progressed = true;
        message.deliveries++;
        const outcome = await handler({
          ...message,
          redelivered: message.deliveries > 1,
          deliveryCount: message.deliveries - 1,
        }).catch(() => "retry" as const);
        if (outcome === "ack") continue;
        const declaration = queues.find((q) => q.name === queue)!;
        const exhausted =
          declaration.kind === "quorum" && message.deliveries > DELIVERY_LIMIT;
        if (outcome === "retry" && !exhausted) pending.push(message);
        else if (declaration.deadLetter)
          this.queues.get("q.dead-letter")!.push({
            ...message,
            headers: {
              ...message.headers,
              "x-first-death-queue": queue,
              "x-first-death-reason":
                outcome === "reject" ? "rejected" : "delivery_limit",
            },
          });
      }
    }
  }

  async close() {}
}

export function newMessageId() {
  return randomUUID();
}
