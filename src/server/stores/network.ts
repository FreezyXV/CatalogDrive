import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** A store error the user must fix (bad key, missing scope, refused data). */
export class StoreError extends Error {
  name = "StoreError";
  constructor(
    message: string,
    public permanent = true,
  ) {
    super(message);
  }
}

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(network, prefix, "ipv6");

export function isPrivateAddress(address: string) {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) return blocked.check(mapped, "ipv4");
  const family = isIP(address);
  if (!family) return true;
  return blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * Anti-SSRF: the store host must resolve only to public addresses.
 * Checked before every sync, not only when the connection is saved.
 */
export async function assertPublicHost(
  hostname: string,
  resolve: typeof lookup = lookup,
) {
  let addresses: { address: string }[];
  try {
    addresses = await resolve(hostname, { all: true, verbatim: true });
  } catch {
    throw new StoreError(`Le domaine ${hostname} est introuvable.`);
  }
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address)))
    throw new StoreError(
      `Le domaine ${hostname} pointe vers une adresse non publique : connexion refusée.`,
    );
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;
export type Transport = {
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
};
export const defaultTransport: Transport = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const RETRYABLE = new Set([429, 502, 503, 504]);

/**
 * HTTP call to a store: 30 s timeout, redirects refused (an open redirect
 * would bypass the host check), bounded retries on rate limit and gateway
 * errors with Retry-After honoured.
 */
export async function storeFetch(
  transport: Transport,
  url: string,
  init: RequestInit,
  attempts = 4,
) {
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await transport.fetch(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      if (attempt >= attempts)
        throw new StoreError("La boutique ne répond pas.", false);
      await transport.sleep(1000 * 2 ** attempt);
      continue;
    }
    if (response.status >= 300 && response.status < 400)
      throw new StoreError(
        "La boutique a répondu par une redirection : vérifiez l’adresse exacte (HTTPS, www, sous-dossier).",
      );
    if (RETRYABLE.has(response.status) && attempt < attempts) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await response.body?.cancel();
      await transport.sleep(
        Math.min(
          20_000,
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 1000 * 2 ** attempt,
        ),
      );
      continue;
    }
    if (response.status === 401 || response.status === 403)
      throw new StoreError(
        "La boutique refuse l’accès : vérifiez la clé d’API et ses autorisations (lecture et écriture des produits).",
      );
    if (response.status === 404)
      throw new StoreError(
        "API introuvable à cette adresse : vérifiez l’URL de la boutique (et, pour WooCommerce, que les permaliens sont activés).",
      );
    if (RETRYABLE.has(response.status) || response.status >= 500)
      throw new StoreError(
        `La boutique est indisponible (HTTP ${response.status}).`,
        false,
      );
    return response;
  }
}

export async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new StoreError(
      "Réponse illisible de la boutique (JSON attendu). Vérifiez l’adresse.",
    );
  }
}
