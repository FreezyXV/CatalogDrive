/**
 * API-first guard: the OpenAPI contract and the Route Handlers must agree.
 * Any route added without being specified (or the reverse) fails the build.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";
import { parse } from "yaml";

const SPEC = "openapi/catamotive-public-api.v1.yaml";
const ROOT = "src/app/api/v1";
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

type Operation = { security?: Record<string, string[]>[] };
type Spec = {
  paths: Record<string, Partial<Record<(typeof METHODS)[number], Operation>>>;
};
const spec = parse(readFileSync(SPEC, "utf8")) as Spec;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === "route.ts" ? [path] : [];
  });
}
const toSpecPath = (file: string) =>
  "/" +
  relative(ROOT, file)
    .split(sep)
    .slice(0, -1)
    .map((segment) => segment.replace(/^\[(.+)\]$/, "{$1}"))
    .join("/");
const toFile = (path: string) =>
  join(
    ROOT,
    ...path
      .split("/")
      .filter(Boolean)
      .map((segment) => segment.replace(/^\{(.+)\}$/, "[$1]")),
    "route.ts",
  );
const exportedMethods = (source: string) =>
  [
    ...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g),
  ].map((m) => m[1].toLowerCase());

describe("contrat OpenAPI v1", () => {
  it("est un document OpenAPI 3.1 valide", async () => {
    const api = await SwaggerParser.validate(SPEC);
    expect(api.info.version).toBe("1.0.0");
  });

  it("chaque opération spécifiée est implémentée", () => {
    for (const [path, item] of Object.entries(spec.paths)) {
      const source = readFileSync(toFile(path), "utf8");
      for (const method of METHODS)
        if (item[method])
          expect(exportedMethods(source), `${method} ${path}`).toContain(
            method,
          );
    }
  });

  it("aucune route v1 n’existe hors contrat", () => {
    for (const file of routeFiles(ROOT)) {
      const path = toSpecPath(file);
      expect(spec.paths[path], `${file} absent du contrat`).toBeDefined();
      for (const method of exportedMethods(readFileSync(file, "utf8")))
        expect(
          spec.paths[path][method as (typeof METHODS)[number]],
          `${method} ${path} non spécifié`,
        ).toBeDefined();
    }
  });

  it("le scope exigé par le code est celui déclaré dans le contrat", () => {
    for (const [path, item] of Object.entries(spec.paths)) {
      const source = readFileSync(toFile(path), "utf8");
      for (const method of METHODS) {
        const operation = item[method];
        if (!operation) continue;
        const declared = (operation.security ?? []).flatMap(
          (requirement) => requirement.oauth2 ?? [],
        );
        const block = source.slice(
          source.indexOf(`export async function ${method.toUpperCase()}`),
        );
        const used = /"(catalog:[a-z]+)"/.exec(block)?.[1];
        if (!declared.length) expect(used, `${method} ${path}`).toBeUndefined();
        else expect(declared, `${method} ${path}`).toEqual([used]);
      }
    }
  });
});
