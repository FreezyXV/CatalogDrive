import { ZodError } from "zod";
import { ImportError } from "@/domain/csv";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const configured = [
    process.env.APP_ORIGIN,
    ...(process.env.APP_ORIGINS?.split(",") ?? []),
  ];
  const allowed = configured.some((value) => {
    if (!value?.trim()) return false;
    try {
      return new URL(value.trim()).origin === origin;
    } catch {
      return false;
    }
  });
  if (!origin || !allowed)
    throw new HttpError(403, "Origine de la requête refusée.");
}
export async function readJson(request: Request, maxBytes = 4096) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Requête vide.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "Requête trop volumineuse.");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Requête JSON invalide.");
  } finally {
    reader.releaseLock();
  }
}
export function errorResponse(error: unknown) {
  if (error instanceof HttpError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof ImportError)
    return Response.json({ error: error.message }, { status: 422 });
  if (error instanceof ZodError)
    return Response.json(
      { error: error.issues[0]?.message ?? "Données invalides." },
      { status: 400 },
    );
  console.error(
    "Erreur serveur CataMotive",
    error instanceof Error ? error.name : "UnknownError",
  );
  return Response.json(
    { error: "Une erreur interne est survenue. Réessayez." },
    { status: 500 },
  );
}
