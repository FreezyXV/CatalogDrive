import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { analyzeCsv, detectFormat, LIMITS } from "../../src/domain/csv";
const analyze = (value: string | Buffer) => {
  const buffer = typeof value === "string" ? Buffer.from(value) : value;
  return analyzeCsv(Readable.from([buffer]), buffer.subarray(0, 65536));
};
describe("diagnostic CSV déterministe", () => {
  it.each([",", ";", "\t"])(
    "détecte le séparateur %s et préserve les codes",
    async (delimiter) => {
      const result = await analyze(
        `sku${delimiter}prix\r\n000123${delimiter}12.50\r\n`,
      );
      expect(result.delimiter).toBe(delimiter);
      expect(result.rowCount).toBe(1);
      expect(result.preview[0].values).toEqual(["000123", "12.50"]);
    },
  );
  it("préserve guillemets, séparateur cité, cellules multilignes et HTML sans exécution", async () => {
    const result = await analyze(
      'sku;description\n001;"texte ; et ""citation""\nsuite"\n002;<script>alert(1)</script>\n',
    );
    expect(result.rowCount).toBe(2);
    expect(result.preview[0]).toEqual({
      line: 3,
      values: ["001", 'texte ; et "citation"\nsuite'],
    });
    expect(result.preview[1].values[1]).toBe("<script>alert(1)</script>");
  });
  it("détecte UTF-8 BOM et saute les lignes physiques vides", async () => {
    const result = await analyze("\ufeff\n\nréf;nom\n\n01;Pièce\n");
    expect(result.headers).toEqual(["réf", "nom"]);
    expect(result.encodingNote).toContain("BOM");
    expect(result.preview[0].line).toBe(5);
  });
  it("décode UTF-16LE avec BOM", async () => {
    const result = await analyze(
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("réf;nom\n01;Pièce\n", "utf16le"),
      ]),
    );
    expect(result.encoding).toBe("utf-16le");
    expect(result.preview[0].values[1]).toBe("Pièce");
  });
  it("décode Windows-1252 en indiquant l'incertitude", async () => {
    const result = await analyze(
      Buffer.from("ref;nom\n01;Pi\xe8ce \x80\n", "latin1"),
    );
    expect(result.encoding).toBe("windows-1252");
    expect(result.encodingNote).toContain("supposé");
    expect(result.preview[0].values[1]).toBe("Pièce €");
  });
  it("supporte un caractère UTF-8 réparti sur deux blocs", async () => {
    const buffer = Buffer.from("ref;nom\n01;Pièce\n");
    const index = buffer.indexOf(0xc3) + 1;
    const result = await analyzeCsv(
      Readable.from([buffer.subarray(0, index), buffer.subarray(index)]),
      buffer,
    );
    expect(result.preview[0].values[1]).toBe("Pièce");
  });
  it("signale en-têtes vides/dupliqués et lignes irrégulières sans perte", async () => {
    const result = await analyze("ref;ref;\n1;2;3;4\n5;6\n");
    expect(result.warnings).toHaveLength(3);
    expect(result.irregularRowCount).toBe(2);
    expect(result.preview[0].values).toHaveLength(4);
  });
  it("borne l'aperçu et compte tout le fichier", async () => {
    const result = await analyze("ref;nom\n" + "1;pièce\n".repeat(1000));
    expect(result.rowCount).toBe(1000);
    expect(result.preview).toHaveLength(20);
  });
  it.each([
    "",
    "ref;nom\n",
    'ref;nom\n1;"non fermé',
    "PK\u0003\u0004faux xlsx",
    "ref;nom\n1;\x00binary",
    "une seule colonne",
    "a,b;c\n1,2;3",
  ])("refuse le fichier inexploitable %j", async (value) => {
    await expect(analyze(value)).rejects.toThrow();
  });
  it("refuse UTF-16BE explicitement", () => {
    expect(() => detectFormat(Buffer.from([0xfe, 0xff, 0, 65]))).toThrow(
      "UTF-16BE",
    );
  });
  it("refuse les enregistrements trop longs", async () => {
    await expect(
      analyze(`a;b\n1;${"x".repeat(LIMITS.recordSize + 1)}`),
    ).rejects.toThrow("64 K");
  });
  it("refuse plus de 200 colonnes", async () => {
    await expect(
      analyze(Array(201).fill("a").join(";") + "\n1;2"),
    ).rejects.toThrow("200 colonnes");
  });
  it("refuse plus de 50 000 lignes", async () => {
    await expect(
      analyze("a;b\n" + "1;2\n".repeat(LIMITS.rows + 1)),
    ).rejects.toThrow("lignes de données");
  });
});
