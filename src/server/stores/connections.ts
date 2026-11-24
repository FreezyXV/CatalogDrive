import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { auditEvents, storeConnections } from "../db/schema";
import { HttpError } from "../http";
import type { Actor } from "../catalog";
import {
  maskSecret,
  normalizeShopifyDomain,
  normalizeWooUrl,
  type ConnectionInput,
  type StoreCredentials,
  type StoreInfo,
} from "@/domain/store-sync";
import { decryptSecret, encryptSecret } from "./crypto";
import { assertPublicHost, StoreError, type Transport } from "./network";
import { shopifyClient } from "./shopify";
import { wooClient } from "./woocommerce";
import type { StoreClient } from "./types";

type Connection = typeof storeConnections.$inferSelect;

/** Public view: never includes the credentials. */
export function publicConnection(connection: Connection) {
  return {
    id: connection.id,
    platform: connection.platform as ConnectionInput["platform"],
    label: connection.label,
    address: connection.address,
    secretHint: connection.secretHint,
    storeName: connection.storeName,
    currency: connection.currency,
    pricesIncludeTax: connection.pricesIncludeTax,
    checkedAt: connection.checkedAt,
  };
}
export type PublicConnection = ReturnType<typeof publicConnection>;

/** Opens an adapter after the anti-SSRF host check. */
export async function openStore(
  connection: Pick<Connection, "id" | "platform" | "address" | "credentials">,
  transport?: Transport,
): Promise<StoreClient> {
  const credentials = JSON.parse(
    decryptSecret(connection.credentials, connection.id),
  ) as StoreCredentials;
  if (credentials.platform === "shopify") {
    const domain = normalizeShopifyDomain(connection.address);
    await assertPublicHost(domain);
    return shopifyClient(domain, credentials.accessToken, transport);
  }
  const url = normalizeWooUrl(connection.address);
  await assertPublicHost(new URL(url).hostname);
  return wooClient(
    url,
    credentials.consumerKey,
    credentials.consumerSecret,
    transport,
  );
}

function asHttpError(error: unknown): never {
  if (error instanceof StoreError) throw new HttpError(422, error.message);
  throw error;
}

export async function listConnections(actor: Actor) {
  const rows = await db
    .select()
    .from(storeConnections)
    .where(eq(storeConnections.organizationId, actor.organizationId))
    .orderBy(desc(storeConnections.createdAt));
  return rows.map(publicConnection);
}

export async function getConnection(actor: Actor, id: string) {
  const [connection] = await db
    .select()
    .from(storeConnections)
    .where(
      and(
        eq(storeConnections.id, id),
        eq(storeConnections.organizationId, actor.organizationId),
      ),
    );
  if (!connection) throw new HttpError(404, "Boutique introuvable.");
  return connection;
}

/**
 * Saves a connection only once the store has answered: a typo in the
 * address or the key is reported immediately, not at the first sync.
 */
export async function createConnection(actor: Actor, input: ConnectionInput) {
  let address: string;
  try {
    address =
      input.platform === "shopify"
        ? normalizeShopifyDomain(input.address)
        : normalizeWooUrl(input.address);
  } catch (error) {
    throw new HttpError(422, (error as Error).message);
  }
  const credentials: StoreCredentials =
    input.platform === "shopify"
      ? { platform: "shopify", accessToken: input.accessToken }
      : {
          platform: "woocommerce",
          consumerKey: input.consumerKey,
          consumerSecret: input.consumerSecret,
        };
  const id = randomUUID();
  const sealed = encryptSecret(JSON.stringify(credentials), id);
  const info = await openStore({
    id,
    platform: input.platform,
    address,
    credentials: sealed,
  })
    .then((client) => client.probe())
    .catch(asHttpError);
  return db.transaction(async (tx) => {
    const [connection] = await tx
      .insert(storeConnections)
      .values({
        id,
        organizationId: actor.organizationId,
        platform: input.platform,
        label: input.label,
        address,
        credentials: sealed,
        secretHint: maskSecret(
          input.platform === "shopify" ? input.accessToken : input.consumerKey,
        ),
        ...storeFields(info),
        createdBy: actor.userId,
      })
      .onConflictDoNothing()
      .returning();
    if (!connection)
      throw new HttpError(409, "Cette boutique est déjà connectée.");
    await tx.insert(auditEvents).values({
      ...actor,
      action: "store.connected",
      entityId: connection.id,
    });
    return publicConnection(connection);
  });
}

const storeFields = (info: StoreInfo) => ({
  storeName: info.name,
  currency: info.currency,
  pricesIncludeTax: info.pricesIncludeTax,
  checkedAt: new Date(),
});

export async function testConnection(actor: Actor, id: string) {
  const connection = await getConnection(actor, id);
  const info = await openStore(connection)
    .then((client) => client.probe())
    .catch(asHttpError);
  const [updated] = await db
    .update(storeConnections)
    .set(storeFields(info))
    .where(eq(storeConnections.id, connection.id))
    .returning();
  return publicConnection(updated);
}

export async function removeConnection(actor: Actor, id: string) {
  const connection = await getConnection(actor, id);
  await db.transaction(async (tx) => {
    await tx
      .delete(storeConnections)
      .where(eq(storeConnections.id, connection.id));
    await tx.insert(auditEvents).values({
      ...actor,
      action: "store.disconnected",
      entityId: connection.id,
    });
  });
}
