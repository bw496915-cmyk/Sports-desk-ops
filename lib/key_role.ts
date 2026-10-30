export type KeyRole = "PK" | `IDX:${string}` | `UQ:${string}`;

export type ParseKeyRole<R extends KeyRole> = R extends "PK"
  ? { readonly type: "primary" }
  : R extends `IDX:${infer N extends string}`
    ? { readonly type: "index"; readonly name: N }
    : R extends `UQ:${infer N extends string}`
      ? { readonly type: "unique"; readonly name: N; readonly partial: boolean }
      : never;

export const parseKeyRole = <const R extends KeyRole>(
  r: R,
): ParseKeyRole<R> => {
  if (r === "PK") {
    return { type: "primary" } as ParseKeyRole<R>;
  }
  if (r.startsWith("IDX:")) {
    return {
      type: "index",
      name: r.slice(4),
    } as ParseKeyRole<R>;
  }
  return {
    type: "unique",
    name: r.slice(3),
    partial: r.includes(" PARTIAL"),
  } as ParseKeyRole<R>;
};

export type KeyRoleTuple<S extends string> =
  S extends `${infer H extends KeyRole},${infer R}`
    ? [H, ...KeyRoleTuple<R>]
    : S extends KeyRole
      ? [S]
      : S extends "—" | ""
        ? []
        : [];
