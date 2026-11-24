import type {
  ItemResult,
  StoreInfo,
  StoreProduct,
  SyncOptions,
} from "@/domain/store-sync";

export type PushOptions = Pick<SyncOptions, "updateMode" | "dryRun">;

/** Port implemented by each store adapter (Shopify, WooCommerce). */
export interface StoreClient {
  /** Reads the store settings that guard a sync; also proves the key works. */
  probe(): Promise<StoreInfo>;
  /**
   * Upserts by SKU: creates missing products as drafts, updates the others.
   * Never throws for a single product: per-row failures are results.
   * Throws StoreError when the whole batch cannot be processed.
   */
  push(products: StoreProduct[], options: PushOptions): Promise<ItemResult[]>;
}

/** Products sent per adapter call; also the cursor granularity of a sync. */
export const PUSH_BATCH = 50;
