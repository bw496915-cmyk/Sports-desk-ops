import type { HexSha256, Iso8601, SnakeCase } from "./brand-validate.ts";
import { SchemaBrandError, schemaBrandMessage } from "./schema_brand_error.ts";

declare const __brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type ContraBrand<T, B extends string> = T & {
  readonly [__brand]: { in: B };
};

export type InvBrand<T, B extends string> = T & {
  readonly [__brand]: { in: B; out: B };
};

export type Sha256Hex = InvBrand<string, "Sha256Hex">;
export type IsoTime = InvBrand<string, "IsoTime">;
export type SqlTableName = Brand<string, "SqlTableName">;
export type SqlColumnName = Brand<string, "SqlColumnName">;
export type SqlIndexName = Brand<string, "SqlIndexName">;
export type SqlDomain = Brand<string, "SqlDomain">;
export type JsonText = Brand<string, "JsonText">;

const SNAKE = /^[a-z][a-z0-9_]{0,62}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function isSha256Hex(value: unknown): value is Sha256Hex {
  return typeof value === "string" && SHA256.test(value);
}

export function isIsoTime(value: unknown): value is IsoTime {
  return typeof value === "string" && !Number.isNaN(Date.parse(value.trim()));
}

export function sqlTable<const T extends string>(
  name: T extends SnakeCase<T> ? T : never,
): Brand<T, "SqlTableName"> {
  if (!SNAKE.test(name)) {
    throw new SchemaBrandError(
      schemaBrandMessage("table", String(name)),
      "table",
      String(name),
    );
  }
  return name as unknown as Brand<T, "SqlTableName">;
}

export function sqlCol<const T extends string>(
  name: T extends SnakeCase<T> ? T : never,
): Brand<T, "SqlColumnName"> {
  if (!SNAKE.test(name)) {
    throw new SchemaBrandError(
      schemaBrandMessage("column", String(name)),
      "column",
      String(name),
    );
  }
  return name as unknown as Brand<T, "SqlColumnName">;
}

export function sqlIndex<const T extends string>(
  name: T extends SnakeCase<T> ? T : never,
): Brand<T, "SqlIndexName"> {
  if (!SNAKE.test(name)) {
    throw new SchemaBrandError(
      schemaBrandMessage("index", String(name)),
      "index",
      String(name),
    );
  }
  return name as unknown as Brand<T, "SqlIndexName">;
}

export function sqlDomain(value: string): SqlDomain {
  const t = value.trim();
  if (t.length === 0) throw new TypeError("SqlDomain must be non-empty");
  return t as SqlDomain;
}

export function sha256<const H extends string>(
  hex: H extends HexSha256<H> ? H : never,
): InvBrand<H, "Sha256Hex"> {
  const normalized = hex.trim().toLowerCase();
  if (!SHA256.test(normalized)) {
    throw new TypeError(`Sha256Hex must be 64 hex chars (len=${hex.length})`);
  }
  return normalized as InvBrand<H, "Sha256Hex">;
}

/** Runtime digest → invariant brand (hash output, not a literal). */
export function sha256FromDigest(hex: string): Sha256Hex {
  return sha256(hex as HexSha256<typeof hex>);
}

export function isoTime<const T extends string>(
  t: T extends Iso8601<T> ? T : string,
): InvBrand<T, "IsoTime"> {
  const trimmed = t.trim();
  if (!isIsoTime(trimmed)) {
    throw new TypeError(`IsoTime: invalid instant: ${t}`);
  }
  return trimmed as InvBrand<T, "IsoTime">;
}

export function jsonText(value: string): JsonText {
  if (value.length === 0) throw new TypeError("JsonText must be non-empty");
  return value as JsonText;
}
