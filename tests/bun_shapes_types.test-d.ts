/**
 * Compile-time half of the shape gate.
 *
 * The type-only entries in `lib/bun_shapes.ts` have no runtime value
 * (`typeof Bun.X === "undefined"`), so they can only be used in type positions.
 * `tests/bun_shapes_coverage.test.ts` checks that the declaration text exists;
 * this file makes `bun run typecheck` prove the compiler resolves each one, which
 * is what callers actually depend on.
 */
import type { Stats } from "node:fs";

export type BunFileShape = Bun.BunFile;
export type FileBlobShape = Bun.FileBlob;
export type FileSinkShape = Bun.FileSink;
export type DollarShape = typeof Bun.$;
export type ShellPromiseShape = Bun.$.ShellPromise;
export type ShellErrorShape = Bun.$.ShellError;
export type ShellOutputShape = Bun.$.ShellOutput;
export type ShellExpressionShape = Bun.ShellExpression;
export type EnvShape = Bun.Env;
export type FetchProxyOptionShape = Bun.FetchProxyOption;
export type CronControllerShape = Bun.CronController;
export type ServerShape = Bun.Server<undefined>;

export type ImportKindShape = Bun.ImportKind;

/** Canonical subtype checks: FileBlob extends BunFile, and BunFile.stat() resolves to node:fs Stats. */
export type FileBlobExtendsBunFileCheck = FileBlobShape extends BunFileShape
  ? true
  : never;
export type BunFileStatReturnCheck =
  Awaited<ReturnType<BunFileShape["stat"]>> extends Stats ? true : never;
export type ShellPromiseAwaitedCheck =
  Awaited<ShellPromiseShape> extends ShellOutputShape ? true : never;
export type ShellErrorExtendsShellOutputCheck =
  ShellErrorShape extends ShellOutputShape ? true : never;

/**
 * Exhaustive switch: a new Bun.ImportKind member fails `bun check` here, and a removed member
 * fails the case label comparison. This pins the documented 9-member union.
 */
export function describeImportKind(kind: Bun.ImportKind): string {
  switch (kind) {
    case "import-statement":
    case "require-call":
    case "require-resolve":
    case "dynamic-import":
    case "import-rule":
    case "url-token":
    case "internal":
    case "entry-point-run":
    case "entry-point-build":
      return kind;
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

/** A runtime shape stays usable in a type position too. */
export type FileShape = ReturnType<typeof Bun.file>;
