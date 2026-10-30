/** Template-literal validators for brand factories (compile-time + runtime). */

export type SnakeCase<S extends string> =
  S extends Lowercase<S>
    ? S extends `${number}${string}`
      ? never
      : S extends `${string} ${string}`
        ? never
        : S extends `${string}-${string}`
          ? never
          : S extends `${string}__${string}`
            ? never
            : S
    : never;

type HexChar =
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f";

type LowerHexChar = HexChar | Uppercase<HexChar>;

type IsHexString<S extends string> =
  S extends Lowercase<S>
    ? S extends `${LowerHexChar}${infer R}`
      ? IsHexString<R>
      : S extends ""
        ? true
        : false
    : false;

export type HexSha256<S extends string> =
  IsHexString<S> extends true ? (S["length"] extends 64 ? S : never) : never;

type Month =
  | "01"
  | "02"
  | "03"
  | "04"
  | "05"
  | "06"
  | "07"
  | "08"
  | "09"
  | "10"
  | "11"
  | "12";

type Day =
  | "01"
  | "02"
  | "03"
  | "04"
  | "05"
  | "06"
  | "07"
  | "08"
  | "09"
  | "10"
  | "11"
  | "12"
  | "13"
  | "14"
  | "15"
  | "16"
  | "17"
  | "18"
  | "19"
  | "20"
  | "21"
  | "22"
  | "23"
  | "24"
  | "25"
  | "26"
  | "27"
  | "28"
  | "29"
  | "30"
  | "31";

/** UTC Zulu instant (subset aligned with `Date#toISOString()`). */
export type Iso8601<S extends string> =
  S extends `${number}-${Month}-${Day}T${number}:${number}:${number}.${number}Z`
    ? S
    : S extends `${number}-${Month}-${Day}T${number}:${number}:${number}Z`
      ? S
      : never;
