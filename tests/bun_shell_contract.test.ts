/**
 * Bun Shell (`Bun.$`) contract, measured on Bun 1.4.4 (2026-11-04).
 *
 * Canonical reference: https://bun.com/reference/globals/bun/$ (`packages/bun-types/shell.d.ts`).
 *
 * The tag is lazy; output methods on the awaited `ShellOutput` are synchronous; `.lines()` is
 * the async iterator (the promise itself is not iterable); an output method implicitly quiets,
 * while a bare await echoes to the parent stdout; `Bun.$.ShellError` (`instanceof $.ShellError`,
 * extending `ShellOutput`) carries `exitCode` and `Buffer` `stdout`/`stderr`.
 *
 * Known 1.4.4 declaration-vs-runtime split: `shell.d.ts` declares `get stdin(): WritableStream`
 * on `ShellPromise` and omits `ShellPromise.bytes()`, whereas the 1.4.4 binary leaves
 * `ShellPromise.prototype.stdin === undefined` and exposes `ShellPromise.prototype.bytes()`.
 * Standard input redirection uses `< ${Buffer | Uint8Array | Blob | Response | ReadableStream}`.
 *
 * Policy: the tag is tooling-only (`scripts/`, `bin/`) and every template-tag invocation captures
 * its output or calls `.quiet()`. Library and daemon code (`lib/`, `services/`, `cli/`) uses
 * `Bun.spawn` with an argv array, and credentials/TTY reads never use a shell
 * (`lib/f402_credentials_policy.ts`).
 */
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript-compiler-legacy";

const ROOT = join(import.meta.dir, "..");
const LIBRARY_ROOTS = ["lib", "services", "cli"] as const;
const TOOLING_ROOTS = ["scripts", "bin"] as const;
const ALL_ROOTS = [...LIBRARY_ROOTS, ...TOOLING_ROOTS];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

const CAPTURE_OR_QUIET_METHODS = new Set([
  "text",
  "json",
  "bytes",
  "arrayBuffer",
  "blob",
  "lines",
  "quiet",
]);

const SHELL_CONFIG_METHODS = new Set(["env", "cwd", "nothrow", "throws"]);

function scriptKindForPath(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".ts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function isBunNamespaceExpr(
  expr: ts.Expression,
  bunNamespaces: ReadonlySet<string>,
): boolean {
  if (ts.isIdentifier(expr) && bunNamespaces.has(expr.text)) return true;
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "globalThis" &&
    expr.name.text === "Bun"
  );
}

function isDollarTagExpr(
  expr: ts.Expression,
  bunNamespaces: ReadonlySet<string>,
  dollarBindings: ReadonlySet<string>,
): boolean {
  if (ts.isIdentifier(expr) && dollarBindings.has(expr.text)) return true;
  if (
    ts.isPropertyAccessExpression(expr) &&
    isBunNamespaceExpr(expr.expression, bunNamespaces) &&
    expr.name.text === "$"
  ) {
    return true;
  }
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    SHELL_CONFIG_METHODS.has(expr.expression.name.text)
  ) {
    return isDollarTagExpr(
      expr.expression.expression,
      bunNamespaces,
      dollarBindings,
    );
  }
  return false;
}

function hasCaptureOrQuietInChain(
  tagNode: ts.TaggedTemplateExpression,
): boolean {
  let current: ts.Node = tagNode;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isParenthesizedExpression(parent)) {
      current = parent;
      continue;
    }
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === current &&
      parent.parent &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent
    ) {
      if (CAPTURE_OR_QUIET_METHODS.has(parent.name.text)) return true;
      current = parent.parent;
      continue;
    }
    break;
  }
  return false;
}

/**
 * Audit one source file against the repo's `Bun.$` policy:
 * - `lib/`, `services/`, `cli/`: zero `Bun.$` or `import { $ } from "bun"` references.
 * - `scripts/`, `bin/` (excluding `bin/bun_surface.ts` presence pins): `Bun.$` is permitted,
 *   and every template-tag invocation must chain a capture method or `.quiet()`.
 */
function auditBunShellSource(relPath: string, sourceText: string): string[] {
  if (relPath === "bin/bun_surface.ts") return [];
  const isLibrary = LIBRARY_ROOTS.some((root) =>
    relPath.startsWith(`${root}/`),
  );
  const sf = ts.createSourceFile(
    relPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(relPath),
  );

  const bunNamespaces = new Set<string>(["Bun"]);
  const dollarBindings = new Set<string>();
  let referencesDollar = false;

  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.moduleSpecifier.text === "bun" &&
      stmt.importClause
    ) {
      if (stmt.importClause.name)
        bunNamespaces.add(stmt.importClause.name.text);
      const bindings = stmt.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        bunNamespaces.add(bindings.name.text);
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          const imported = (el.propertyName ?? el.name).text;
          if (imported === "$") {
            referencesDollar = true;
            if (!stmt.importClause.isTypeOnly && !el.isTypeOnly) {
              dollarBindings.add(el.name.text);
            }
          }
        }
      }
    }
  }

  const offenders: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      isBunNamespaceExpr(node.expression, bunNamespaces) &&
      node.name.text === "$"
    ) {
      referencesDollar = true;
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined
    ) {
      const isBunInit =
        isBunNamespaceExpr(node.initializer, bunNamespaces) ||
        (ts.isAwaitExpression(node.initializer) &&
          ts.isCallExpression(node.initializer.expression) &&
          node.initializer.expression.expression.kind ===
            ts.SyntaxKind.ImportKeyword &&
          node.initializer.expression.arguments.length === 1 &&
          ts.isStringLiteral(node.initializer.expression.arguments[0]!) &&
          node.initializer.expression.arguments[0]!.text === "bun");
      if (isBunInit && ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          const prop = (
            el.propertyName && ts.isIdentifier(el.propertyName)
              ? el.propertyName
              : ts.isIdentifier(el.name)
                ? el.name
                : null
          )?.text;
          if (prop === "$") {
            referencesDollar = true;
            if (ts.isIdentifier(el.name)) dollarBindings.add(el.name.text);
          }
        }
      } else if (
        ts.isPropertyAccessExpression(node.initializer) &&
        isBunNamespaceExpr(node.initializer.expression, bunNamespaces) &&
        node.initializer.name.text === "$" &&
        ts.isIdentifier(node.name)
      ) {
        referencesDollar = true;
        dollarBindings.add(node.name.text);
      }
    } else if (
      ts.isTaggedTemplateExpression(node) &&
      isDollarTagExpr(node.tag, bunNamespaces, dollarBindings)
    ) {
      referencesDollar = true;
      if (!isLibrary && !hasCaptureOrQuietInChain(node)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        offenders.push(
          `${relPath}:${line + 1}: Bun.$ template tag must capture output or call .quiet()`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (isLibrary && referencesDollar) {
    return [`${relPath}: library/daemon root may not reference Bun.$`];
  }
  return offenders;
}

describe("Bun Shell contract", () => {
  test("the template tag starts no process until awaited", async () => {
    const { $ } = await import("bun");
    const marker = join(
      tmpdir(),
      `bun-shell-lazy-${process.pid}-${Date.now()}`,
    );
    const pending = $`touch ${marker}`.quiet();
    try {
      expect(await Bun.file(marker).exists()).toBe(false);
      await pending;
      expect(await Bun.file(marker).exists()).toBe(true);
    } finally {
      await $`rm -f ${marker}`.quiet().nothrow();
    }
  });

  test("ShellOutput methods are synchronous, ShellPromise mirrors them", async () => {
    const { $ } = await import("bun");
    const output = await $`printf 'alpha\nbeta\n'`.quiet();
    // `shell.d.ts` declares `class ShellOutput` inside `namespace $`, but Bun 1.4.4 exposes
    // `$.ShellPromise` and `$.ShellError` as runtime constructors while `$.ShellOutput` is undefined.
    expect(
      ($ as unknown as Record<string, unknown>)["ShellOutput"],
    ).toBeUndefined();
    expect(output.constructor.name).toBe("ShellOutput");
    expect(output.text()).toBe("alpha\nbeta\n");
    expect(output.bytes()).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(output.bytes()).toString("utf8")).toBe("alpha\nbeta\n");
    expect(output.arrayBuffer()).toBeInstanceOf(ArrayBuffer);
    expect(typeof output.blob()).toBe("object");
    expect(await $`printf '{"ok":true}'`.json()).toEqual({ ok: true });

    const pending = $`true`;
    expect(pending).toBeInstanceOf($.ShellPromise);
    expect(pending.text()).toBeInstanceOf(Promise);
    for (const method of [
      "lines",
      "quiet",
      "nothrow",
      "throws",
      "cwd",
      "env",
    ] as const) {
      expect(typeof pending[method]).toBe("function");
    }
  });

  test("ShellPromise.stdin is undefined on 1.4.4; < redirects Buffer, Blob, and Response", async () => {
    const { $ } = await import("bun");
    // `shell.d.ts` declares `get stdin(): WritableStream` on `ShellPromise` and omits `.bytes()`,
    // while Bun 1.4.4 leaves `ShellPromise.prototype.stdin === undefined` and defines `.bytes()`.
    expect(
      Object.getOwnPropertyDescriptor($.ShellPromise.prototype, "stdin"),
    ).toBeUndefined();
    const idle = $`true`;
    expect((idle as { stdin?: unknown }).stdin).toBeUndefined();
    expect(typeof (idle as unknown as { bytes?: unknown }).bytes).toBe(
      "function",
    );

    expect((await $`cat < ${Buffer.from("buf-in\n")}`.text()).trim()).toBe(
      "buf-in",
    );
    expect((await $`cat < ${new Blob(["blob-in\n"])}`.text()).trim()).toBe(
      "blob-in",
    );
    expect((await $`cat < ${new Response("resp-in\n")}`.text()).trim()).toBe(
      "resp-in",
    );
  });

  test("lines() is the async iterable and keeps the trailing empty line", async () => {
    const { $ } = await import("bun");
    const lines: string[] = [];
    for await (const line of $`printf 'one\ntwo\nthree\n'`.lines()) {
      lines.push(line);
    }
    expect(lines).toEqual(["one", "two", "three", ""]);
  });

  test("ShellError is instanceof Bun.$.ShellError and carries exitCode and Buffer stdout/stderr", async () => {
    const { $ } = await import("bun");
    let caught: unknown = null;
    try {
      await $`sh -c 'echo OUT; echo ERR >&2; exit 3'`.quiet();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf($.ShellError);
    if (!(caught instanceof $.ShellError)) {
      throw new Error("expected Bun.$.ShellError");
    }
    expect(caught.name).toBe("ShellError");
    expect(caught.exitCode).toBe(3);
    expect(Buffer.isBuffer(caught.stdout)).toBe(true);
    expect(Buffer.isBuffer(caught.stderr)).toBe(true);
    expect(caught.stdout.toString().trim()).toBe("OUT");
    expect(caught.stderr.toString().trim()).toBe("ERR");
    expect(caught.text().trim()).toBe("OUT");
    expect(caught.bytes()).toBeInstanceOf(Uint8Array);
  });

  test("an output method quiets, a bare await echoes to the parent stdout", async () => {
    const run = async (code: string): Promise<string> => {
      const child = Bun.spawn([process.execPath, "-e", code], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return stdout;
    };

    const captured = await run(
      'import { $ } from "bun"; const text = await $`echo CAPTURED`.text(); console.log("TEXT:" + text.trim());',
    );
    expect(captured.trim()).toBe("TEXT:CAPTURED");

    const bare = await run(
      'import { $ } from "bun"; await $`echo BARE-ECHO`; console.log("DONE");',
    );
    expect(bare).toContain("BARE-ECHO");
    expect(bare).toContain("DONE");
  });

  test("auditBunShellSource rejects library refs and bare tags while allowing captured tooling tags", () => {
    expect(
      auditBunShellSource(
        "lib/bad.ts",
        'import { $ } from "bun";\nexport const run = () => $`echo no`.text();\n',
      ),
    ).toEqual(["lib/bad.ts: library/daemon root may not reference Bun.$"]);
    expect(
      auditBunShellSource(
        "services/bad.ts",
        "export const q = (s: string) => Bun.$.escape(s);\n",
      ),
    ).toEqual(["services/bad.ts: library/daemon root may not reference Bun.$"]);
    expect(
      auditBunShellSource(
        "scripts/bare.ts",
        'import { $ } from "bun";\nawait $`echo bare`.nothrow();\n',
      ),
    ).toEqual([
      "scripts/bare.ts:2: Bun.$ template tag must capture output or call .quiet()",
    ]);
    expect(
      auditBunShellSource(
        "scripts/ok.ts",
        'import { $ } from "bun";\nconst a = await $`echo ok`.env({ A: "1" }).text();\nawait Bun.$`true`.nothrow().quiet();\nconst b = Bun.$.braces("a.{ts,js}");\n',
      ),
    ).toEqual([]);
  });

  test("the tag is tooling-only and always captures or quiets", async () => {
    const listed = Bun.spawnSync({
      cmd: ["git", "ls-files", ...ALL_ROOTS],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (listed.exitCode !== 0) {
      throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
    }
    const offenders: string[] = [];
    for (const path of listed.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((entry) =>
        SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext)),
      )) {
      const file = Bun.file(join(ROOT, path));
      // Unstaged working-tree deletions remain in `git ls-files` until staged; skip absent files.
      if (!(await file.exists())) continue;
      offenders.push(...auditBunShellSource(path, await file.text()));
    }
    expect(offenders).toEqual([]);
  });
});
