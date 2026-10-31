import { absurd } from "./exhaustive.ts";

/** Typed brand-constructor failures (schema CLI jump-to-error). */
export type SchemaBrandKind =
  "column" | "table" | "index" | "domain" | "sha256" | "iso";

export class SchemaBrandError extends TypeError {
  override readonly name = "SchemaBrandError";
  readonly kind: SchemaBrandKind;
  readonly identifier: string;

  constructor(message: string, kind: SchemaBrandKind, identifier: string) {
    super(message);
    this.kind = kind;
    this.identifier = identifier;
  }
}

export function schemaBrandMessage(
  kind: SchemaBrandKind,
  identifier: string,
): string {
  switch (kind) {
    case "column":
      return `invalid column name: ${identifier}`;
    case "table":
      return `invalid table name: ${identifier}`;
    case "index":
      return `invalid index name: ${identifier}`;
    case "domain":
      return `invalid sql domain: ${identifier}`;
    case "sha256":
      return `invalid sha256 hex: ${identifier}`;
    case "iso":
      return `invalid iso time: ${identifier}`;
    default:
      return absurd(kind);
  }
}
