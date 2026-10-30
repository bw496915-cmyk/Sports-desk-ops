import type { IsoTime, JsonText, Sha256Hex } from "./brand.ts";
import type { Millis } from "./units.ts";
import type { SqliteStorageKind } from "./sqlite_schema_registry.ts";

export type Nullable = "YES" | "NO";

export type ColumnValueType<
  K extends SqliteStorageKind,
  N extends Nullable,
> = K extends "integer_pk"
  ? number
  : K extends "integer"
    ? N extends "YES"
      ? number | null
      : number
    : K extends "real"
      ? N extends "YES"
        ? number | null
        : number
      : K extends "text_iso_time"
        ? N extends "YES"
          ? IsoTime | null
          : IsoTime
        : K extends "text_sha256"
          ? Sha256Hex
          : K extends "text_json"
            ? JsonText
            : K extends "text_enum" | "text"
              ? N extends "YES"
                ? string | null
                : string
              : never;

export type StorageKindToValue<K extends SqliteStorageKind> = ColumnValueType<
  K,
  "NO"
>;

/** Per-column unit overrides (phantom units on numeric columns). */
export type ColumnUnitOverride<
  T extends string,
  C extends string,
> = T extends "match_evaluations"
  ? C extends "time_diff_ms"
    ? Millis
    : never
  : never;
