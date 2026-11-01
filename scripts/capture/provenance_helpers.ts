/**
 * @file scripts/capture/provenance_helpers.ts
 * @description Derive capture provenance axes from probe page results (DOM + HTTP),
 *              classify populated vs populated-shell vs empty-envelope bodies,
 *              and verify DOM origin/version/WAF consistency.
 */

import type { ProbePageResult } from "../../lib/f402_probe.ts";
import { canonicalJson, sha256Hex } from "./json.ts";
import type {
  CaptureBodyVerdict,
  CaptureMutationVerdict,
  CaptureObservation,
  CaptureProvenance,
  CaptureRequestVerdict,
  CaptureViewMode,
  CaptureWafVerdict,
} from "./types.ts";

/** Edge infrastructure paths — not origin API surface. */
export const CAPTURE_EDGE_PATH_PREFIXES = ["/cdn-cgi/"] as const;

export function isCaptureEdgePath(pathname: string): boolean {
  return CAPTURE_EDGE_PATH_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix),
  );
}

export function normalizeCfRay(value: string): string {
  return value.trim();
}

export function cfRayFromResponseHeaders(
  headers: Headers | Readonly<Record<string, string | undefined>>,
): string | undefined {
  const read = (name: string): string | undefined => {
    if (headers instanceof Headers) {
      const v = headers.get(name);
      return v && v.length > 0 ? normalizeCfRay(v) : undefined;
    }
    const record = headers as Record<string, string | undefined>;
    const direct = record[name] ?? record[name.toLowerCase()];
    return typeof direct === "string" && direct.length > 0
      ? normalizeCfRay(direct)
      : undefined;
  };
  return read("cf-ray") ?? read("CF-Ray");
}

/**
 * Dynamic-content patterns require rendered *content* inside game/wager elements,
 * never just an empty `<div data-component="game">` container where every
 * `data-field` span is empty.
 */
export const HTML_DYNAMIC_CONTENT_PATTERNS = [
  // A populated game row has a team name, not just an empty span
  /<span[^>]*data-field\s*=\s*["']team-[123]["'][^>]*>\s*[^<\s][^<]*<\/span>/i,
  // Or a non-empty content-page-out child beyond the empty wrapper
  /class\s*=\s*["'][^"']*content-page-out[^"']*["'][^>]*>\s*<(?!\/)[a-z][^>]*>(?!\s*<\/)/i,
  // Or a rendered wager marker
  /data-wager\s*=\s*["'][^"']+["']/i,
] as const;

/**
 * Shell markers prove that the server or client shell template rendered
 * (`version`, `domain-me`, `content-page-out`, or an unpopulated `data-component="game"`
 * template), not that dynamic data arrived.
 */
export const HTML_SHELL_MARKER_PATTERNS = [
  /data-field\s*=\s*["']version["']/i,
  /data-field\s*=\s*["']domain-me["']/i,
  /data-component\s*=\s*["']game["']/i,
  /class\s*=\s*["'][^"']*content-page-out[^"']*["']/i,
  /class\s*=\s*["'][^"']*page-done[^"']*["']/i,
] as const;

/**
 * True when a JSON text payload is an empty envelope (`{"LIST":""}`, `{"LIST":[]}`,
 * `{"LIST":null}`, `{"Pending":[]}`, `[]`, `{}`) rather than populated domain rows.
 */
export function isJsonEmptyEnvelope(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "[]" || trimmed === "{}") return true;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.length === 0;
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      const keys = Object.keys(obj);
      if (keys.length === 0) return true;
      if ("LIST" in obj) {
        const list = obj["LIST"];
        if (list === "" || list === null) return true;
        if (Array.isArray(list) && list.length === 0) return true;
      }
      if (
        "Pending" in obj &&
        Array.isArray(obj["Pending"]) &&
        obj["Pending"].length === 0
      ) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Classify an HTML response preview as:
 * - `"populated"`: contains rendered team names, non-empty `content-page-out` children, or wager rows
 * - `"populated-shell"`: contains shell chrome (`version`, `domain-me`, or an empty `data-component="game"` template)
 * - `"template"`: unpopulated HTML markup without server shell markers
 */
export function classifyHtmlBodyVerdict(
  htmlPreview: string,
  observed?: {
    domVersion?: string | undefined;
    domOrigin?: string | undefined;
  },
): "populated" | "populated-shell" | "template" {
  for (const pattern of HTML_DYNAMIC_CONTENT_PATTERNS) {
    if (pattern.test(htmlPreview)) return "populated";
  }
  const hasServerShellMarkers =
    (observed?.domVersion !== undefined && observed.domVersion.trim() !== "") ||
    (observed?.domOrigin !== undefined && observed.domOrigin.trim() !== "") ||
    HTML_SHELL_MARKER_PATTERNS.some((pattern) => pattern.test(htmlPreview));
  if (hasServerShellMarkers) {
    return "populated-shell";
  }
  return "template";
}

export function inferBodyVerdict(
  status: number,
  bytes: number,
  preview?: string,
  observed?: {
    contentType?: string | undefined;
    domVersion?: string | undefined;
    domOrigin?: string | undefined;
  },
): CaptureBodyVerdict {
  if (bytes === 0 && status >= 500) return "empty-500";
  if (bytes === 0 && status >= 400) return "error-body";
  if (bytes === 0 && status >= 200 && status < 300) return "empty-envelope";
  const text = preview?.trim() ?? "";
  if (text.length === 0 && bytes > 0) return "none";
  if (status >= 400) return "error-body";
  if (status >= 200 && status < 300) {
    const ct = (observed?.contentType ?? "").toLowerCase();
    const isJsonPayload =
      ct.includes("json") ||
      (!ct.includes("text/html") &&
        (text.startsWith("{") || text.startsWith("[")));
    const looksLikeHtml =
      ct.includes("text/html") ||
      (!isJsonPayload &&
        (text.startsWith("<") ||
          HTML_SHELL_MARKER_PATTERNS.some((p) => p.test(text)) ||
          (observed?.domVersion !== undefined && observed.domVersion !== "")));

    if (looksLikeHtml) {
      return classifyHtmlBodyVerdict(text, observed);
    }
    if (isJsonEmptyEnvelope(text)) {
      return "empty-envelope";
    }
    return "populated";
  }
  return "none";
}

export function deriveWafFromSignals(options: {
  cfRay?: string | undefined;
  challengePresent?: boolean | undefined;
}): CaptureWafVerdict {
  if (options.cfRay && options.cfRay.length > 0) return "cloudflare";
  if (options.challengePresent === true) return "cloudflare";
  return "unknown";
}

export function deriveWafFromProbe(result: ProbePageResult): CaptureWafVerdict {
  const effectiveCfRay =
    result.cfRay ??
    result.cfRayFromHeader ??
    cfRayFromResponseHeaders(result.responseHeaders ?? {});
  return deriveWafFromSignals({
    cfRay: effectiveCfRay,
    challengePresent: result.challengePresent,
  });
}

export interface ProbeCaptureProvenanceInput {
  portalHost: string;
  bunVersion: string;
  backend?: "webkit" | "chrome" | undefined;
  headersObserved?: boolean | undefined;
  viewMode?: CaptureViewMode | undefined;
  sessionStorageCleared?: boolean | undefined;
  betTickerParam?: boolean | undefined;
  request?: CaptureRequestVerdict | undefined;
  mutation?: CaptureMutationVerdict | undefined;
}

export interface ProbeDomObservation {
  readonly status: number;
  readonly bytes: number;
  readonly preview: string;
  readonly contentType?: string | undefined;
  readonly domVersion?: string | undefined;
  readonly domOrigin?: string | undefined;
  readonly cfRay?: string | undefined;
  readonly cfRayFromHeader?: string | undefined;
  readonly responseHeaders?:
    Readonly<Record<string, string | undefined>> | undefined;
  readonly challengePresent?: boolean | undefined;
}

function buildProvenance(
  base: ProbeCaptureProvenanceInput,
  observation: CaptureObservation,
  result: ProbeDomObservation,
): CaptureProvenance {
  const effectiveCfRay =
    result.cfRay ??
    result.cfRayFromHeader ??
    cfRayFromResponseHeaders(result.responseHeaders ?? {});
  const waf = deriveWafFromSignals({
    cfRay: effectiveCfRay,
    challengePresent: result.challengePresent,
  });
  const body = inferBodyVerdict(result.status, result.bytes, result.preview, {
    contentType: result.contentType,
    domVersion: result.domVersion,
    domOrigin: result.domOrigin,
  });
  return {
    portalHost: base.portalHost,
    proxy: "none",
    auth: "cookie",
    bunVersion: base.bunVersion,
    ...(result.domOrigin ? { origin: result.domOrigin } : {}),
    observation,
    body,
    mutation: base.mutation ?? "read-inferred",
    request: base.request ?? "minimal",
    waf,
    ...(effectiveCfRay ? { cfRay: effectiveCfRay } : {}),
    ...(base.backend ? { backend: base.backend } : {}),
    ...(base.headersObserved === true ? { headersObserved: true } : {}),
    state: {
      viewMode: base.viewMode ?? "unknown",
      sessionStorageCleared: base.sessionStorageCleared ?? false,
      betTickerParam: base.betTickerParam ?? false,
      ...(result.domVersion ? { domVersion: result.domVersion } : {}),
      ...(result.domOrigin ? { domOrigin: result.domOrigin } : {}),
      challengePresent: result.challengePresent === true,
    },
  };
}

/** Merge base probe run metadata with in-page observation (DOM + fetch). */
export function provenanceFromProbePage(
  base: ProbeCaptureProvenanceInput,
  result: ProbePageResult,
): CaptureProvenance {
  const observation: CaptureObservation =
    base.backend === "chrome"
      ? "cdp"
      : base.backend === "webkit"
        ? "webkit"
        : "authored";
  return buildProvenance(base, observation, result);
}

/** Bun `fetch` / HAR replay: no DOM challenge signals unless caller passes them. */
export function provenanceFromWireFetch(
  base: ProbeCaptureProvenanceInput,
  result: ProbeDomObservation,
  responseHeaders?: Headers | Readonly<Record<string, string | undefined>>,
): CaptureProvenance {
  const cfRay =
    result.cfRay ??
    result.cfRayFromHeader ??
    cfRayFromResponseHeaders(responseHeaders ?? result.responseHeaders ?? {}) ??
    undefined;
  return buildProvenance(base, "har", {
    ...result,
    cfRay,
    challengePresent: result.challengePresent === true,
  });
}

export interface ProvenanceDriftReport {
  readonly ok: boolean;
  /** True when `domOrigin` (`[data-field="domain-me"]`) disagrees with `portalHost` (e.g. staging vs prod). */
  readonly originMismatch: boolean;
  /** True when `domVersion` (`[data-field="version"]`) disagrees with expected bundle version (deploy-in-progress). */
  readonly versionMismatch: boolean;
  /** True when `waf` and `cfRay` disagree (`waf === "cloudflare"` without `cfRay`, or `cfRay` with `waf !== "cloudflare"`). */
  readonly wafRayMismatch: boolean;
  readonly canonicalPortalHost: string;
  readonly canonicalDomOrigin: string | null;
  readonly domVersion: string | null;
  readonly expectedVersion: string | null;
  readonly issues: readonly string[];
}

function stripWwwAndPort(hostOrOrigin: string): string {
  const trimmed = hostOrOrigin
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "");
  const hostOnly = (trimmed.split("/")[0] ?? "").split(":")[0] ?? "";
  return hostOnly.replace(/^www\./, "");
}

/**
 * Validate provenance consistency across:
 * 1. `state.domOrigin` / `origin` (`[data-field="domain-me"]`) vs `portalHost`
 * 2. `state.domVersion` (`[data-field="version"]`) vs expected bundle version
 * 3. `waf` vs `cfRay` (`waf === "cloudflare"` requires `cfRay`; `cfRay` requires `waf === "cloudflare"`)
 */
export function verifyProvenanceConsistency(
  provenance: CaptureProvenance,
  options: { expectedVersion?: string; allowWwwSubdomain?: boolean } = {},
): ProvenanceDriftReport {
  const issues: string[] = [];
  const allowWww = options.allowWwwSubdomain ?? true;
  const rawDomOrigin =
    provenance.state?.domOrigin?.trim() ?? provenance.origin?.trim() ?? "";
  const domOrigin = rawDomOrigin === "" ? null : rawDomOrigin;
  const rawDomVersion = provenance.state?.domVersion?.trim() ?? "";
  const domVersion = rawDomVersion === "" ? null : rawDomVersion;
  const expectedVersion = options.expectedVersion?.trim() || null;

  const normalizeHost = (h: string): string =>
    allowWww ? stripWwwAndPort(h) : h.trim().toLowerCase();

  const canonicalPortalHost = normalizeHost(provenance.portalHost);
  const canonicalDomOrigin =
    domOrigin === null ? null : normalizeHost(domOrigin);

  const originMismatch =
    canonicalDomOrigin !== null && canonicalDomOrigin !== canonicalPortalHost;
  if (originMismatch) {
    issues.push(
      `DOM origin "${domOrigin}" ([data-field="domain-me"]) disagrees with portalHost "${provenance.portalHost}"`,
    );
  }

  const versionMismatch =
    domVersion !== null &&
    expectedVersion !== null &&
    domVersion !== expectedVersion;
  if (versionMismatch) {
    issues.push(
      `DOM version "${domVersion}" ([data-field="version"]) disagrees with bundle version "${expectedVersion}" (deploy-in-progress skew)`,
    );
  }

  let wafRayMismatch = false;
  if (provenance.waf === "cloudflare" && !provenance.cfRay) {
    wafRayMismatch = true;
    issues.push(`waf is "cloudflare" but no cfRay captured`);
  }
  if (provenance.cfRay && provenance.waf !== "cloudflare") {
    wafRayMismatch = true;
    issues.push(
      `cfRay "${provenance.cfRay}" present but waf is "${provenance.waf}"`,
    );
  }

  return {
    ok: issues.length === 0,
    originMismatch,
    versionMismatch,
    wafRayMismatch,
    canonicalPortalHost,
    canonicalDomOrigin,
    domVersion,
    expectedVersion,
    issues,
  };
}

/** True when a 2xx body may only hold for this clearance / Ray lifecycle. */
export function isChallengeBoundCapture(
  provenance: CaptureProvenance,
): boolean {
  const edge =
    provenance.waf === "cloudflare" ||
    provenance.state?.challengePresent === true ||
    Boolean(provenance.cfRay?.length);
  if (!edge) return false;
  const body = provenance.body ?? "none";
  return (
    body === "populated" ||
    body === "populated-shell" ||
    body === "empty-envelope"
  );
}

/**
 * Fingerprint for challenge-bound captures (Ray + backend + challenge flag).
 * Does not embed cookies — pair with separate clearance capture when needed.
 */
export function captureRecipeFingerprint(
  provenance: CaptureProvenance,
): string | undefined {
  if (!isChallengeBoundCapture(provenance)) return undefined;
  return sha256Hex(
    canonicalJson({
      cfRay: provenance.cfRay ?? "",
      waf: provenance.waf ?? "unknown",
      challengePresent: provenance.state?.challengePresent === true,
      backend: provenance.backend ?? "",
    }),
  );
}

export { isCloudflareEdgeDrop } from "./cloudflare_edge.ts";
