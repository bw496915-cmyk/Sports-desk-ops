declare const __urlScheme: unique symbol;
declare const __urlPath: unique symbol;

export type TypedURL<S extends string, P extends string = string> = URL & {
  readonly [__urlScheme]: S;
  readonly [__urlPath]: P;
};

export type ProtocolOf<U extends TypedURL<string>> = U[typeof __urlScheme];
export type PathOf<U extends TypedURL<string>> = U[typeof __urlPath];

export type FileURL = TypedURL<"file">;
export type SqliteURL = TypedURL<"sqlite">;
export type HttpsURL = TypedURL<"https">;
export type HttpsURLAt<H extends string> = TypedURL<"https"> & {
  readonly hostname: H;
};

export type DatabaseURL = FileURL | SqliteURL;
export type ManifestURL = FileURL | HttpsURL;

export function asFileURL<const U extends URL>(
  u: U & { protocol: "file:" },
): FileURL {
  return u as unknown as FileURL;
}

export function asSqliteURL<const U extends URL>(
  u: U & { protocol: "sqlite:" },
): SqliteURL {
  return u as unknown as SqliteURL;
}

export function asHttpsURL<const U extends URL>(
  u: U & { protocol: "https:" },
): HttpsURL {
  return u as unknown as HttpsURL;
}

export function asHttpsURLAt<const H extends string>(
  u: URL & { protocol: "https:"; hostname: H },
): HttpsURLAt<H> {
  return u as unknown as HttpsURLAt<H>;
}

export function asDatabaseURL(input: string | URL): DatabaseURL {
  const u = typeof input === "string" ? new URL(input) : input;
  if (u.protocol === "file:") return asFileURL(u as URL & { protocol: "file:" });
  if (u.protocol === "sqlite:") {
    return asSqliteURL(u as URL & { protocol: "sqlite:" });
  }
  throw new TypeError(`expected file: or sqlite: URL, got ${u.protocol}`);
}

export function asManifestURL(input: string | URL): ManifestURL {
  const u = typeof input === "string" ? new URL(input) : input;
  if (u.protocol === "file:") return asFileURL(u as URL & { protocol: "file:" });
  if (u.protocol === "https:") {
    return asHttpsURL(u as URL & { protocol: "https:" });
  }
  throw new TypeError(`expected file: or https: manifest URL, got ${u.protocol}`);
}

export function defaultDocsBaseUrl(): HttpsURLAt<"sportsdesk.internal"> {
  const u = new URL("https://sportsdesk.internal/schema/");
  return asHttpsURLAt(
    u as URL & { protocol: "https:"; hostname: "sportsdesk.internal" },
  );
}
