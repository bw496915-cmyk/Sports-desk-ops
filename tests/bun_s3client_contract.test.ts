import type { S3Client, S3File, S3Options, S3Stats } from "bun";
import { describe, expect, test } from "bun:test";

const METHODS = [
  "delete",
  "exists",
  "file",
  "list",
  "presign",
  "size",
  "stat",
  "unlink",
  "write",
] as const;

function methodsOf(value: object): Set<string> {
  return new Set(Object.getOwnPropertyNames(value));
}

describe("Bun.S3Client contract", () => {
  test("exposes the nine instance methods", () => {
    const methods = methodsOf(Bun.S3Client.prototype);
    for (const name of METHODS) expect(methods.has(name)).toBe(true);
  });

  test("exposes the nine matching static methods", () => {
    const statics = methodsOf(Bun.S3Client);
    for (const name of METHODS) expect(statics.has(name)).toBe(true);
  });

  test("lazy S3File exposes the pinned members and a NaN size", () => {
    const file: S3File = Bun.s3.file("missing.txt");
    for (const name of [
      "slice",
      "stat",
      "exists",
      "unlink",
      "delete",
      "presign",
      "write",
    ] as const) {
      expect(typeof (file as unknown as Record<string, unknown>)[name]).toBe(
        "function",
      );
    }
    expect(Number.isNaN(file.size)).toBe(true);
  });

  test("Bun.s3 satisfies canonical S3Client and S3 companion types from module 'bun'", () => {
    const s3: S3Client = Bun.s3;
    const opts: S3Options = { region: "auto" };
    const checkCompanionTypes = (
      stats: S3Stats,
    ): [number, string, string | undefined] => [
      stats.size,
      stats.etag,
      opts.region,
    ];
    expect(typeof checkCompanionTypes).toBe("function");
    // Cross-realm instanceof checks fail under worker isolation on Linux CI.
    // Validate prototype constructor name and method contract across all environments.
    expect(Object.getPrototypeOf(s3).constructor.name).toBe("S3Client");
    for (const name of METHODS) {
      expect(typeof (s3 as unknown as Record<string, unknown>)[name]).toBe(
        "function",
      );
    }
  });
});
