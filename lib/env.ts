import { asDatabaseURL, type DatabaseURL } from "./urls.ts";

export type EnvName =
  | "SPORTSDESK_SCHEMA_DB"
  | "SPORTSDESK_DB"
  | "SPORTSDESK_STRICT";

export interface EnvVar<N extends EnvName> {
  readonly name: N;
  readonly value: string;
}

export function env<const N extends EnvName>(name: N): EnvVar<N> {
  const value = Bun.env[name];
  if (value === undefined) {
    throw new Error(`missing env: ${name}`);
  }
  return { name, value };
}

export function envOptional<const N extends EnvName>(
  name: N,
): EnvVar<N> | undefined {
  const value = Bun.env[name];
  if (value === undefined) return undefined;
  return { name, value };
}

export function schemaDatabaseUrlFromEnv(): DatabaseURL | undefined {
  const v =
    envOptional("SPORTSDESK_SCHEMA_DB") ?? envOptional("SPORTSDESK_DB");
  return v === undefined ? undefined : asDatabaseURL(v.value);
}
