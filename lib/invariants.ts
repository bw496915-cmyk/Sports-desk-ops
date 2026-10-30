/** Compile-time SSOT structural checks (no runtime code). */

type ColumnKindMap = Record<string, { readonly kind: string }>;

type PkColumns<C extends ColumnKindMap> = {
  [K in keyof C as C[K]["kind"] extends "integer_pk" ? K : never]: K;
};

export type AssertExactlyOnePk<C extends ColumnKindMap> = [
  keyof PkColumns<C>,
] extends [never]
  ? { readonly __error: "table must have exactly one integer_pk column"; got: 0 }
  : [keyof PkColumns<C>] extends [infer _Only extends keyof PkColumns<C>]
    ? [keyof PkColumns<C>] extends [_Only]
      ? unknown
      : {
          readonly __error: "table must have exactly one integer_pk column";
          readonly cols: keyof PkColumns<C>;
        }
    : { readonly __error: "table must have exactly one integer_pk column" };

/** Zero or one `integer_pk` (enrich caches without surrogate keys). */
export type AssertAtMostOnePk<C extends ColumnKindMap> = [
  keyof PkColumns<C>,
] extends [never]
  ? unknown
  : [keyof PkColumns<C>] extends [infer _Only extends keyof PkColumns<C>]
    ? [keyof PkColumns<C>] extends [_Only]
      ? unknown
      : {
          readonly __error: "at most one integer_pk column";
          readonly cols: keyof PkColumns<C>;
        }
    : { readonly __error: "at most one integer_pk column" };

export type AssertIndexColsExist<
  C extends ColumnKindMap,
  IdxCols extends readonly string[],
> = IdxCols extends readonly [
  infer H extends string,
  ...infer R extends readonly string[],
]
  ? H extends keyof C
    ? AssertIndexColsExist<C, R>
    : {
        readonly __error: "index references unknown column";
        readonly column: H;
      }
  : unknown;

type JsonSiblingFor<
  C extends ColumnKindMap,
  S extends string,
> = S extends `${infer Base}_sha256`
  ? Base extends keyof C
    ? C[Base] extends { kind: "text_json" }
      ? unknown
      : { readonly __error: "json sibling has wrong kind"; readonly column: Base }
    : unknown
  : unknown;

type Sha256ColumnKeys<C extends ColumnKindMap> = {
  [K in keyof C]: K extends `${string}_sha256` ? K : never;
}[keyof C];

export type AssertShaPairs<C extends ColumnKindMap> = [
  Sha256ColumnKeys<C>,
] extends [never]
  ? unknown
  : {
      [K in Sha256ColumnKeys<C>]: JsonSiblingFor<C, K & string>;
    }[Sha256ColumnKeys<C>];

type IndexInvariants<
  C extends ColumnKindMap,
  I extends Record<string, { readonly columns: readonly string[] }>,
> = [keyof I] extends [never]
  ? unknown
  : {
      [K in keyof I]: AssertIndexColsExist<C, I[K]["columns"]>;
    }[keyof I];

export type TableInvariants<
  C extends ColumnKindMap,
  I extends Record<string, { readonly columns: readonly string[] }>,
  PkPolicy extends "required" | "optional" = "required",
> = (PkPolicy extends "required" ? AssertExactlyOnePk<C> : AssertAtMostOnePk<C>) &
  AssertShaPairs<C> &
  IndexInvariants<C, I>;
