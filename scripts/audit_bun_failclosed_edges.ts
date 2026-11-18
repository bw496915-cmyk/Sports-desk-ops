#!/usr/bin/env bun
// scripts/audit_bun_failclosed_edges.ts
// Audits sportsdesk-ops call sites against Bun v1.4.4+ fail-closed TypeError / RangeError contracts.

import ts from "typescript";
import { resolve, relative } from "node:path";

const enum Severity {
  ERROR = "ERROR", // Guaranteed or high-risk runtime TypeError / RangeError
  WARN = "WARN", // Needs runtime range/NaN guard or behavior changed in v1.4.4+
}

interface Finding {
  readonly ruleId: string;
  readonly severity: Severity;
  readonly file: string;
  readonly line: number;
  readonly col: number;
  readonly snippet: string;
  readonly detail: string;
}

const HASH_ALGO_NAMES = new Set([
  "wyhash",
  "adler32",
  "crc32",
  "cityHash32",
  "cityHash64",
  "murmur32v3",
  "murmur32v2",
  "murmur64v2",
  "rapidhash",
]);

const STATIC_HASHER_CLASSES = new Set([
  "SHA1",
  "SHA224",
  "SHA256",
  "SHA384",
  "SHA512",
  "SHA512_256",
  "MD4",
  "MD5",
]);
const GLOB_BOOL_KEYS = new Set([
  "dot",
  "onlyFiles",
  "followSymlinks",
  "absolute",
  "throwErrorOnBrokenSymlink",
]);

function loadTypeScriptProgram(tsconfigPath: string): ts.Program {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      `ERR_AUDIT_TSCONFIG_READ: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    resolve(tsconfigPath, ".."),
  );
  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });
}

function typeContainsNullable(type: ts.Type, checker: ts.TypeChecker): boolean {
  const parts = type.isUnion() ? type.types : [type];
  for (const t of parts) {
    if (
      (t.flags &
        (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)) !==
      0
    ) {
      return true;
    }
    const text = checker.typeToString(t);
    if (text === "undefined" || text === "null") return true;
  }
  return false;
}

function typeContainsFileOrBlobHandle(
  type: ts.Type,
  checker: ts.TypeChecker,
): string | null {
  const parts = type.isUnion() ? type.types : [type];
  for (const t of parts) {
    const symName = t.getSymbol()?.getName() ?? "";
    const text = checker.typeToString(t);
    if (
      symName === "BunFile" ||
      symName === "S3File" ||
      symName === "BuildArtifact" ||
      /\b(BunFile|S3File|BuildArtifact)\b/.test(text) ||
      text.startsWith("Promise<")
    ) {
      return text;
    }
  }
  return null;
}

function typeAllowsStringOrNonBuffer(
  type: ts.Type,
  checker: ts.TypeChecker,
): string | null {
  const parts = type.isUnion() ? type.types : [type];
  for (const t of parts) {
    if (
      (t.flags &
        (ts.TypeFlags.String |
          ts.TypeFlags.StringLiteral |
          ts.TypeFlags.Number |
          ts.TypeFlags.Boolean)) !==
      0
    ) {
      return checker.typeToString(t);
    }
    if ((t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
      return checker.typeToString(t);
    }
  }
  return null;
}

function isUnvalidatedPortExpr(expr: ts.Expression): boolean {
  const unwrapped = ts.isParenthesizedExpression(expr) ? expr.expression : expr;
  if (ts.isNumericLiteral(unwrapped)) {
    const n = Number(unwrapped.text);
    return !Number.isInteger(n) || n < 1 || n > 65535;
  }
  if (ts.isIdentifier(unwrapped) && unwrapped.text === "NaN") return true;
  if (
    ts.isPropertyAccessExpression(unwrapped) &&
    ts.isIdentifier(unwrapped.expression) &&
    unwrapped.expression.text === "Number" &&
    unwrapped.name.text === "NaN"
  ) {
    return true;
  }
  // Flag direct parseInt(url.port) / Number(url.port) / +url.port without Number.isInteger guard
  if (ts.isCallExpression(unwrapped)) {
    const callee = unwrapped.expression.getText();
    if (
      callee === "parseInt" ||
      callee === "Number.parseInt" ||
      callee === "Number"
    ) {
      return true;
    }
  }
  if (
    ts.isPrefixUnaryExpression(unwrapped) &&
    unwrapped.operator === ts.SyntaxKind.PlusToken
  ) {
    return true;
  }
  return false;
}

function auditSourceFile(
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  rootDir: string,
  findings: Finding[],
): void {
  const relPath = relative(rootDir, sf.fileName);
  if (
    relPath.startsWith("node_modules") ||
    sf.isDeclarationFile ||
    relPath.endsWith(".generated.ts")
  ) {
    return;
  }

  const record = (
    node: ts.Node,
    ruleId: string,
    severity: Severity,
    detail: string,
  ): void => {
    const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    // Negative tests deliberately pass a forbidden handle; annotate the exact rule on the
    // current or preceding line rather than weakening the gate for the whole file.
    const marker = "audit:bun-failclosed-ignore";
    const lines = sf.text.split(/\r?\n/);
    if (
      (lines[pos.line] ?? "").includes(`${marker} ${ruleId}`) ||
      (lines[pos.line - 1] ?? "").includes(`${marker} ${ruleId}`)
    ) {
      return;
    }
    const raw = node.getText(sf).replace(/\s+/g, " ");
    findings.push({
      ruleId,
      severity,
      file: relPath,
      line: pos.line + 1,
      col: pos.character + 1,
      snippet: raw.length > 96 ? `${raw.slice(0, 93)}...` : raw,
      detail,
    });
  };

  const visit = (node: ts.Node): void => {
    // 1. new Bun.Glob("...") brace-recursion audit
    if (
      ts.isNewExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(sf) === "Bun" &&
      node.expression.name.text === "Glob" &&
      node.arguments &&
      node.arguments.length > 0
    ) {
      const patArg = node.arguments[0]!;
      if (ts.isStringLiteralLike(patArg) && /\{[^}]*\*\*/.test(patArg.text)) {
        record(
          node,
          "BUN-GLOB-BRACE-STARSTAR",
          Severity.WARN,
          "Pattern uses `**` inside `{...}` braces: now matches nested subdirectories recursively (previously acted like single `*`). Verify scope matches intent.",
        );
      }
    }

    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      const exprText = expr.getText(sf);

      // 2. Bun.dns.prefetch(hostname, port?) -> NaN / out-of-range port throws RangeError
      if (exprText === "Bun.dns.prefetch") {
        if (node.arguments.length >= 2) {
          const portArg = node.arguments[1]!;
          const portType = checker.getTypeAtLocation(portArg);
          if (typeContainsNullable(portType, checker)) {
            record(
              portArg,
              "BUN-DNS-PREFETCH-PORT",
              Severity.WARN,
              "Second arg to Bun.dns.prefetch() may be undefined/nullable; verify NaN cannot flow in (throws RangeError).",
            );
          } else if (isUnvalidatedPortExpr(portArg)) {
            record(
              portArg,
              "BUN-DNS-PREFETCH-NAN-RISK",
              Severity.ERROR,
              "Direct numeric coercion (`parseInt`/`Number`/`+`) in Bun.dns.prefetch() port throws RangeError on empty `url.port` (`NaN`). Guard `1 <= port <= 65535`.",
            );
          }
        }
      }

      // 3. Bun.indexOfLine(buffer, offset?) -> non-buffer throws TypeError instead of -1
      if (exprText === "Bun.indexOfLine") {
        const bufArg = node.arguments[0];
        if (!bufArg) {
          record(
            node,
            "BUN-INDEXOFLINE-ARITY",
            Severity.ERROR,
            "Bun.indexOfLine() called with 0 arguments (throws TypeError).",
          );
        } else {
          const bufType = checker.getTypeAtLocation(bufArg);
          const badType = typeAllowsStringOrNonBuffer(bufType, checker);
          const fileHandle = typeContainsFileOrBlobHandle(bufType, checker);
          if (badType || fileHandle || typeContainsNullable(bufType, checker)) {
            record(
              bufArg,
              "BUN-INDEXOFLINE-NON-BUFFER",
              Severity.ERROR,
              `First arg type \`${checker.typeToString(bufType)}\` is not strictly ArrayBufferView/ArrayBuffer; now throws TypeError instead of returning -1.`,
            );
          }
        }
      }

      // 4. Bun.hash / Bun.hash.<algo> / Bun.SHA256.hash / hasher.update -> S3File, BunFile, null, undefined throw TypeError
      const isBunHashCall =
        exprText === "Bun.hash" ||
        exprText === "Bun.sha" ||
        exprText === "crypto.hash" ||
        (ts.isPropertyAccessExpression(expr) &&
          expr.expression.getText(sf) === "Bun.hash" &&
          HASH_ALGO_NAMES.has(expr.name.text)) ||
        (ts.isPropertyAccessExpression(expr) &&
          ts.isPropertyAccessExpression(expr.expression) &&
          expr.expression.expression.getText(sf) === "Bun" &&
          STATIC_HASHER_CLASSES.has(expr.expression.name.text) &&
          expr.name.text === "hash");

      const isHasherInstanceUpdate =
        ts.isPropertyAccessExpression(expr) &&
        expr.name.text === "update" &&
        checker
          .typeToString(checker.getTypeAtLocation(expr.expression))
          .includes("CryptoHasher");

      if (isBunHashCall || isHasherInstanceUpdate) {
        const dataArgIndex = exprText === "crypto.hash" ? 1 : 0;
        const dataArg = node.arguments[dataArgIndex];
        if (!dataArg) {
          record(
            node,
            "BUN-HASH-EMPTY-ARG",
            Severity.ERROR,
            `${exprText}() called without input argument; now throws TypeError instead of hashing "".`,
          );
        } else {
          const argType = checker.getTypeAtLocation(dataArg);
          const handleName = typeContainsFileOrBlobHandle(argType, checker);
          if (handleName) {
            record(
              dataArg,
              "BUN-HASH-FILE-HANDLE",
              Severity.ERROR,
              `Arg passes \`${handleName}\` to ${exprText}(); S3File / BunFile / BuildArtifact / Promise now throws TypeError (await \`.bytes()\` first).`,
            );
          } else if (typeContainsNullable(argType, checker)) {
            record(
              dataArg,
              "BUN-HASH-NULLABLE-ARG",
              Severity.ERROR,
              `Arg type \`${checker.typeToString(argType)}\` permits null/undefined in ${exprText}(); now throws TypeError instead of hashing "undefined"/"null".`,
            );
          }
        }
      }

      // 5. Bun.TOML.parse / Bun.YAML.parse -> S3File / BunFile throws TypeError instead of {} or null
      if (exprText === "Bun.TOML.parse" || exprText === "Bun.YAML.parse") {
        const inputArg = node.arguments[0];
        if (!inputArg) {
          record(
            node,
            "BUN-PARSE-EMPTY-ARG",
            Severity.ERROR,
            `${exprText}() called with 0 arguments.`,
          );
        } else {
          const argType = checker.getTypeAtLocation(inputArg);
          const handleName = typeContainsFileOrBlobHandle(argType, checker);
          if (handleName) {
            record(
              inputArg,
              "BUN-PARSE-FILE-HANDLE",
              Severity.ERROR,
              `${exprText}() receives \`${handleName}\`; S3File / BunFile now throws TypeError instead of returning {} or null (await \`.text()\` first).`,
            );
          } else if (
            typeAllowsStringOrNonBuffer(argType, checker) === null ||
            typeContainsNullable(argType, checker)
          ) {
            record(
              inputArg,
              "BUN-PARSE-NON-STRING",
              Severity.WARN,
              `${exprText}() arg type is \`${checker.typeToString(argType)}\`; verify decoded UTF-8 \`string\` is passed.`,
            );
          }
        }
      }

      // 6. glob.scan(...) / glob.scanSync(...) -> non-boolean truthy flags ({ dot: 1 })
      if (
        ts.isPropertyAccessExpression(expr) &&
        (expr.name.text === "scan" || expr.name.text === "scanSync") &&
        checker
          .typeToString(checker.getTypeAtLocation(expr.expression))
          .includes("Glob")
      ) {
        const optArg = node.arguments[0];
        if (optArg && ts.isObjectLiteralExpression(optArg)) {
          for (const prop of optArg.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              GLOB_BOOL_KEYS.has(prop.name.getText(sf))
            ) {
              const propType = checker.getTypeAtLocation(prop.initializer);
              if (
                (propType.flags &
                  (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) ===
                0
              ) {
                record(
                  prop,
                  "BUN-GLOB-NONBOOL-OPTION",
                  Severity.WARN,
                  `Glob.${expr.name.text} option \`${prop.name.getText(sf)}\` has non-boolean type \`${checker.typeToString(propType)}\`; pass strict boolean.`,
                );
              }
            }
          }
        }
      }

      // 7. Bun.gzipSync / Bun.deflateSync -> memLevel (1..9) & strategy (0..4) range check
      if (exprText === "Bun.gzipSync" || exprText === "Bun.deflateSync") {
        const optArg = node.arguments[1];
        if (optArg && ts.isObjectLiteralExpression(optArg)) {
          for (const prop of optArg.properties) {
            if (!ts.isPropertyAssignment(prop)) continue;
            const key = prop.name.getText(sf);
            if (key === "memLevel" && ts.isNumericLiteral(prop.initializer)) {
              const v = Number(prop.initializer.text);
              if (!Number.isInteger(v) || v < 1 || v > 9) {
                record(
                  prop,
                  "BUN-ZLIB-MEMLEVEL-RANGE",
                  Severity.ERROR,
                  `${exprText} memLevel=${v} outside 1..9 now throws.`,
                );
              }
            }
            if (key === "strategy" && ts.isNumericLiteral(prop.initializer)) {
              const v = Number(prop.initializer.text);
              if (!Number.isInteger(v) || v < 0 || v > 4) {
                record(
                  prop,
                  "BUN-ZLIB-STRATEGY-RANGE",
                  Severity.ERROR,
                  `${exprText} strategy=${v} outside 0..4 now throws.`,
                );
              }
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
}

function main(): void {
  const startNs = Bun.nanoseconds();
  const rootDir = process.cwd();
  const tsconfigPath = resolve(rootDir, "tsconfig.json");
  const strictWarn = process.argv.includes("--fail-on-warn");
  const jsonOut = process.argv.includes("--json");

  const program = loadTypeScriptProgram(tsconfigPath);
  const checker = program.getTypeChecker();
  const findings: Finding[] = [];
  let scannedFiles = 0;

  for (const sf of program.getSourceFiles()) {
    const rel = relative(rootDir, sf.fileName);
    if (
      !rel.startsWith("node_modules") &&
      !sf.isDeclarationFile &&
      !rel.endsWith(".generated.ts")
    ) {
      scannedFiles++;
      auditSourceFile(sf, checker, rootDir, findings);
    }
  }

  const elapsedMs = ((Bun.nanoseconds() - startNs) / 1e6).toFixed(1);
  const errorCount = findings.filter(
    (f) => f.severity === Severity.ERROR,
  ).length;
  const warnCount = findings.filter((f) => f.severity === Severity.WARN).length;

  if (jsonOut) {
    process.stdout.write(
      `${JSON.stringify({ scannedFiles, elapsedMs: Number(elapsedMs), errorCount, warnCount, findings }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `[audit:bun-failclosed] Scanned ${scannedFiles} TypeScript files in ${elapsedMs}ms -> ${errorCount} ERROR, ${warnCount} WARN\n`,
    );
    for (const f of findings) {
      process.stdout.write(
        `  [${f.severity}] ${f.ruleId} ${f.file}:${f.line}:${f.col}\n    code: ${f.snippet}\n    why:  ${f.detail}\n`,
      );
    }
  }

  if (errorCount > 0 || (strictWarn && warnCount > 0)) {
    process.exit(65); // EX_DATAERR — aligns with sportsdesk-ops CI gate contract
  }
}

main();
