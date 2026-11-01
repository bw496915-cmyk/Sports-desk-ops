/**
 * Boundary parse for `CaptureProvenance` (full evidence axes on read).
 */

import type {
  CaptureBodyVerdict,
  CaptureMutationVerdict,
  CaptureObservation,
  CaptureProvenance,
  CaptureProvenanceState,
  CaptureRequestVerdict,
  CaptureViewMode,
  CaptureWafVerdict,
} from "./types.ts";

function fail(field: string, expected: string): never {
  throw new Error(`invalid capture provenance: ${field} must be ${expected}`);
}

function expectObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(field, "an object");
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") fail(field, "a string");
  return value;
}

function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(field, "a boolean");
  return value;
}

function expectEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  const s = expectString(value, field);
  if (!allowed.includes(s as T)) {
    fail(field, allowed.map((item) => `"${item}"`).join(" | "));
  }
  return s as T;
}

function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  return expectEnum(value, field, allowed);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return expectString(value, field);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  return expectBoolean(value, field);
}

const OBSERVATIONS = [
  "cdp",
  "webkit",
  "har",
  "code",
  "authored",
] as const satisfies readonly CaptureObservation[];

const BODY_VERDICTS = [
  "populated",
  "populated-shell",
  "empty-envelope",
  "template",
  "error-body",
  "empty-500",
  "none",
] as const satisfies readonly CaptureBodyVerdict[];

const REQUEST_VERDICTS = [
  "exact",
  "minimal",
  "sentinel",
  "synthetic",
  "mismatched",
] as const satisfies readonly CaptureRequestVerdict[];

const MUTATION_VERDICTS = [
  "read",
  "read-inferred",
  "write",
  "unknown",
] as const satisfies readonly CaptureMutationVerdict[];

const WAF_VERDICTS = [
  "cloudflare",
  "none",
  "unknown",
] as const satisfies readonly CaptureWafVerdict[];

const VIEW_MODES = [
  "desktop",
  "mobile",
  "unknown",
] as const satisfies readonly CaptureViewMode[];

function expectProvenanceState(
  value: unknown,
  field: string,
): CaptureProvenanceState | undefined {
  if (value === undefined) return undefined;
  const state = expectObject(value, field);
  const out: CaptureProvenanceState = {};
  const viewMode = optionalEnum(
    state["viewMode"],
    `${field}.viewMode`,
    VIEW_MODES,
  );
  if (viewMode !== undefined) out.viewMode = viewMode;
  const sessionStorageCleared = optionalBoolean(
    state["sessionStorageCleared"],
    `${field}.sessionStorageCleared`,
  );
  if (sessionStorageCleared !== undefined) {
    out.sessionStorageCleared = sessionStorageCleared;
  }
  const betTickerParam = optionalBoolean(
    state["betTickerParam"],
    `${field}.betTickerParam`,
  );
  if (betTickerParam !== undefined) out.betTickerParam = betTickerParam;
  const domVersion = optionalString(state["domVersion"], `${field}.domVersion`);
  if (domVersion !== undefined) out.domVersion = domVersion;
  const domOrigin = optionalString(state["domOrigin"], `${field}.domOrigin`);
  if (domOrigin !== undefined) out.domOrigin = domOrigin;
  const challengePresent = optionalBoolean(
    state["challengePresent"],
    `${field}.challengePresent`,
  );
  if (challengePresent !== undefined) out.challengePresent = challengePresent;
  return out;
}

/** Validate untrusted provenance (call `normalizeProvenance` before hashing). */
export function parseCaptureProvenance(
  value: unknown,
  field = "provenance",
): CaptureProvenance {
  const provenance = expectObject(value, field);
  const proxy = expectString(provenance["proxy"], `${field}.proxy`);
  if (proxy !== "env" && proxy !== "none") {
    fail(`${field}.proxy`, '"env" or "none"');
  }
  const auth = expectString(provenance["auth"], `${field}.auth`);
  if (auth !== "cookie" && auth !== "none") {
    fail(`${field}.auth`, '"cookie" or "none"');
  }
  const origin = optionalString(provenance["origin"], `${field}.origin`);
  const observation = optionalEnum(
    provenance["observation"],
    `${field}.observation`,
    OBSERVATIONS,
  );
  const body = optionalEnum(provenance["body"], `${field}.body`, BODY_VERDICTS);
  const request = optionalEnum(
    provenance["request"],
    `${field}.request`,
    REQUEST_VERDICTS,
  );
  const mutation = optionalEnum(
    provenance["mutation"],
    `${field}.mutation`,
    MUTATION_VERDICTS,
  );
  const waf = optionalEnum(provenance["waf"], `${field}.waf`, WAF_VERDICTS);
  const cfRay = optionalString(provenance["cfRay"], `${field}.cfRay`);
  const prefix = optionalString(provenance["prefix"], `${field}.prefix`);
  const backend = optionalEnum(provenance["backend"], `${field}.backend`, [
    "webkit",
    "chrome",
  ] as const);
  const headersObserved = optionalBoolean(
    provenance["headersObserved"],
    `${field}.headersObserved`,
  );
  const state = expectProvenanceState(provenance["state"], `${field}.state`);

  return {
    portalHost: expectString(provenance["portalHost"], `${field}.portalHost`),
    proxy,
    auth,
    bunVersion: expectString(provenance["bunVersion"], `${field}.bunVersion`),
    ...(origin === undefined ? {} : { origin }),
    ...(observation === undefined ? {} : { observation }),
    ...(body === undefined ? {} : { body }),
    ...(request === undefined ? {} : { request }),
    ...(mutation === undefined ? {} : { mutation }),
    ...(waf === undefined ? {} : { waf }),
    ...(cfRay === undefined ? {} : { cfRay }),
    ...(prefix === undefined ? {} : { prefix }),
    ...(backend === undefined ? {} : { backend }),
    ...(headersObserved === undefined ? {} : { headersObserved }),
    ...(state === undefined ? {} : { state }),
  };
}
