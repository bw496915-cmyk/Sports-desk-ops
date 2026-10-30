import type { IsoTime, JsonText } from "./brand.ts";

export type ParseIso<S extends IsoTime> =
  S extends `${infer Y}-${infer M}-${infer D}T${infer H}:${infer Mi}:${infer Ss}Z`
    ? {
        readonly year: Y;
        readonly month: M;
        readonly day: D;
        readonly hour: H;
        readonly minute: Mi;
        readonly second: Ss;
        readonly utc: true;
      }
    : S extends `${infer Y}-${infer M}-${infer D}T${infer H}:${infer Mi}:${infer Ss}.${infer _Ms}Z`
      ? {
          readonly year: Y;
          readonly month: M;
          readonly day: D;
          readonly hour: H;
          readonly minute: Mi;
          readonly second: Ss;
          readonly utc: true;
        }
      : never;

export function parseIso<const S extends IsoTime>(s: S): ParseIso<S> {
  const m = s.match(/^(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)(?:\.\d+)?Z$/)!;
  return {
    year: m[1]!,
    month: m[2]!,
    day: m[3]!,
    hour: m[4]!,
    minute: m[5]!,
    second: m[6]!,
    utc: true,
  } as ParseIso<S>;
}

export type JsonShape<T> = { readonly [K in keyof T]: T[K] };

export function parseJson<S extends JsonShape<unknown>>(
  text: JsonText,
  schema: S,
): { readonly [K in keyof S]: S[K] } {
  const obj = JSON.parse(text) as Record<string, unknown>;
  for (const k of Object.keys(schema)) {
    if (!(k in obj)) throw new TypeError(`missing key: ${k}`);
  }
  return obj as { readonly [K in keyof S]: S[K] };
}
