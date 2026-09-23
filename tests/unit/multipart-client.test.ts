import { afterEach, describe, expect, it, vi } from "vitest";
import { transferInParts } from "../../src/components/upload-form";

const partBytes = 5 * 1024 * 1024;
const file = () =>
  new File([new Uint8Array(26 * 1024 * 1024)], "catalogue.csv", {
    type: "text/csv",
  });

afterEach(() => vi.unstubAllGlobals());

describe("transfert multipart dans le navigateur", () => {
  it("borne les uploads concurrents à quatre et termine après toutes les parties", async () => {
    let active = 0;
    let maximum = 0;
    const transferred: number[] = [];
    const progress: number[] = [];
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      if (input === "/api/uploads/multipart") {
        const body = JSON.parse(String(init.body));
        if (body.action === "start")
          return Response.json({ token: "test", partBytes });
        if (body.action === "part")
          return Response.json({ url: `https://store.test/${body.number}` });
        if (body.action === "complete") {
          expect(active).toBe(0);
          expect(transferred).toHaveLength(6);
          return Response.json({ key: "completed" });
        }
      }
      const number = Number(input.split("/").pop());
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      transferred.push(number);
      active--;
      return new Response(null, { status: 200 });
    });
    expect(await transferInParts(file(), (value) => progress.push(value))).toBe(
      "completed",
    );
    expect(maximum).toBe(4);
    expect(transferred.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(progress.at(-1)).toBe(100);
  });

  it("attend les requêtes lancées avant d’annuler une session en échec", async () => {
    let active = 0;
    let retries = 0;
    let aborted = false;
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      if (input === "/api/uploads/multipart") {
        const body = JSON.parse(String(init.body));
        if (body.action === "start")
          return Response.json({ token: "test", partBytes });
        if (body.action === "part")
          return Response.json({ url: `https://store.test/${body.number}` });
        if (body.action === "abort") {
          expect(active).toBe(0);
          aborted = true;
          return Response.json({ ok: true });
        }
        if (body.action === "complete")
          throw new Error("Une session incomplète ne doit pas être terminée.");
      }
      const number = Number(input.split("/").pop());
      active++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (number === 2) {
        retries++;
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 200 });
    });
    await expect(transferInParts(file(), () => undefined)).rejects.toThrow(
      "Partie 2 refusée",
    );
    expect(retries).toBe(3);
    expect(aborted).toBe(true);
  });
});
