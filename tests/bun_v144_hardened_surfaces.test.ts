import { expect, test } from "bun:test";
import { CFunction, cc, type Pointer } from "bun:ffi";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("version floor covers the hardened surface set", () => {
  expect(Bun.semver.satisfies(Bun.version, ">=1.4.4-0")).toBe(true);
});

test("hash family refuses no-arg/null/undefined/file handles with TypeError", () => {
  const handle = Bun.file(import.meta.path);
  const noArg = Bun.hash as unknown as () => bigint;
  const crcNoArg = Bun.hash.crc32 as unknown as () => number;
  expect(() => noArg()).toThrow(TypeError);
  expect(() => crcNoArg()).toThrow(TypeError);
  expect(() => Bun.hash(null as never)).toThrow(TypeError);
  expect(() => Bun.hash(undefined as never)).toThrow(TypeError);
  expect(() => Bun.hash(handle as never)).toThrow(TypeError);
  expect(() => Bun.hash.crc32(null as never)).toThrow(TypeError);
});

test("NaN options are RangeError, not TypeError", () => {
  // audit:bun-failclosed-ignore BUN-DNS-PREFETCH-NAN-RISK
  expect(() => Bun.dns.prefetch("example.com", Number.NaN)).toThrow(RangeError);
  expect(() => Bun.CSRF.generate("secret", { expiresIn: Number.NaN })).toThrow(
    RangeError,
  );

  const token = Bun.CSRF.generate("secret", { expiresIn: 60_000 });
  expect(() =>
    Bun.CSRF.verify(token, { secret: "secret", maxAge: Number.NaN }),
  ).toThrow(RangeError);

  expect(() => Bun.gzipSync("x", { memLevel: 0 } as never)).toThrow(RangeError);
  expect(() => Bun.gzipSync("x", { strategy: 5 } as never)).toThrow(RangeError);
  expect(() => Bun.deflateSync("x", { strategy: -1 } as never)).toThrow(
    RangeError,
  );
});

test("$.escape coerces; it is not an input validator", () => {
  expect(Bun.$.escape(null as never)).toBe("null");
  expect(Bun.$.escape(true as never)).toBe("true");
  expect(Bun.$.escape(new String("foo") as never)).toBe("foo");
  expect(typeof Bun.$.escape(42 as never)).toBe("string");
});

test("globstar inside braces matches deep paths", () => {
  // audit:bun-failclosed-ignore BUN-GLOB-BRACE-STARSTAR
  const brace = new Bun.Glob("{src/**,lib/**}");
  expect(brace.match("src/a/b.ts")).toBe(true);
  expect(brace.match("lib/a/b.ts")).toBe(true);

  const many = new Bun.Glob(
    `{${Array.from({ length: 12 }, (_, i) => `p${i}/**`).join(",")}}`,
  );
  expect(many.match("p11/a/b.ts")).toBe(true);

  let nested = "a";
  for (let i = 0; i < 12; i += 1) nested = `{${nested},x${i}}`;
  expect(new Bun.Glob(nested).match("a")).toBe(true);
});

test("scan truthy options include dotfiles and exclude directories", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bun-glob-truthy-"));
  try {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "visible.txt"), "");
    writeFileSync(join(dir, ".hidden"), "");

    const dotted: string[] = [];
    for await (const rel of new Bun.Glob("*").scan({
      cwd: dir,
      dot: 1,
    } as never)) {
      dotted.push(rel);
    }
    expect(dotted).toContain(".hidden");

    const files = Array.from(
      new Bun.Glob("*").scanSync({ cwd: dir, onlyFiles: 1 } as never),
    );
    expect(files).toContain("visible.txt");
    expect(files).not.toContain("sub");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CSRF generate(undefined, options) keeps the default secret", () => {
  expect(typeof Bun.CSRF.generate(undefined, { expiresIn: 60_000 })).toBe(
    "string",
  );
});

test("JSON5 rejects embedded NUL trailing tokens and escaped identifier hyphens", () => {
  expect(() => Bun.JSON5.parse("1\0 2")).toThrow(SyntaxError);
  expect(() => Bun.JSON5.parse(String.raw`{a\u002d: 1}`)).toThrow(SyntaxError);
});

test("gzipSync and deflateSync honor non-default strategy and memLevel options", () => {
  const payload = Buffer.from("a".repeat(2000) + "b".repeat(2000));
  const def = Bun.gzipSync(payload, { strategy: 0 }).byteLength;
  const huff = Bun.gzipSync(payload, { strategy: 2 }).byteLength;
  const rle = Bun.gzipSync(payload, { strategy: 3 }).byteLength;
  expect(huff).toBeGreaterThan(def);
  expect(rle).toBeLessThanOrEqual(def);
  expect(
    Bun.gunzipSync(Bun.gzipSync(payload, { memLevel: 1, strategy: 3 })),
  ).toEqual(payload);
});

test("JSONL.parse and parseChunk advance past returned values on stray , ] } and blank lines", () => {
  const c1 = Bun.JSONL.parseChunk("1,");
  expect(c1.values).toEqual([1]);
  expect(c1.read).toBe(1);
  expect(c1.done).toBe(false);

  const c2 = Bun.JSONL.parseChunk("\n\n1,");
  expect(c2.values).toEqual([1]);
  expect(c2.read).toBe(3);

  expect(Bun.JSONL.parse("\n\n1,")).toEqual([1]);
  expect(Bun.JSONL.parseChunk("1]").values).toEqual([1]);
  expect(Bun.JSONL.parseChunk("\n\n1}").values).toEqual([1]);
});

test("markdown.ansi keeps inline code attached to trailing punctuation without mid-word wrap", () => {
  const stripped = Bun.stripANSI(
    Bun.markdown.ansi("0123456789 `code`.\n", { width: 16 } as never),
  );
  expect(stripped).toContain("code.");
  expect(stripped).not.toContain("code\n.");
});

test("bun:ffi cc() symbol .ptr points to the compiled C function address", () => {
  const dir = mkdtempSync(join(tmpdir(), "bun-ffi-cc-ptr-"));
  try {
    const src = join(dir, "add.c");
    writeFileSync(src, "int add42(int x) { return x + 42; }\n");
    const { symbols } = cc({
      source: src,
      symbols: { add42: { args: ["i32"], returns: "i32" } },
    });
    const add42 = symbols.add42 as unknown as {
      (x: number): number;
      readonly ptr: Pointer;
    };
    expect(add42(8)).toBe(50);
    expect(Number(add42.ptr)).toBeGreaterThan(0);
    const fn = CFunction({
      ptr: add42.ptr,
      args: ["i32"],
      returns: "i32",
    });
    expect(fn(8)).toBe(50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
