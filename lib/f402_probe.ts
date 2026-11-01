/**
 * @file lib/f402_probe.ts
 * @description Probe plan for the F402 report reads, executed inside a signed-in WebView page.
 *
 * The point is to observe what the portal returns for each named report, not to assert a contract.
 * Paths come from `lib/combo_identity.ts` (`[UNVERIFIED]` names); the method and body are a starting
 * hypothesis, so a 404/405/401 is a real finding and every result is labelled with what was sent.
 *
 * `PendingDelete` is excluded by default: the name reads like a mutation, and the capture allowlist
 * refuses mutations by construction.
 */

export interface ProbeOp {
  readonly operation: string;
  readonly method: "POST";
  /** False for operations whose read-only nature has not been confirmed. */
  readonly readOnly: boolean;
  readonly note: string;
}

export const PROBE_OPS: readonly ProbeOp[] = [
  {
    operation: "Pending",
    method: "POST",
    readOnly: true,
    note: "already in the capture allowlist as getPending",
  },
  {
    operation: "getDailyFiguresByCustomer",
    method: "POST",
    readOnly: true,
    note: "daily figure report read",
  },
  {
    operation: "getGradedWagerByCustomer",
    method: "POST",
    readOnly: true,
    note: "graded wager report read",
  },
  {
    operation: "getTransactions",
    method: "POST",
    readOnly: true,
    note: "transaction report read",
  },
  {
    operation: "getGrading",
    method: "POST",
    readOnly: true,
    note: "grading report read; also settles the channel model",
  },
  {
    operation: "getTicketDetailPrint",
    method: "POST",
    readOnly: true,
    note: "ticket detail read",
  },
  {
    operation: "PendingDelete",
    method: "POST",
    readOnly: false,
    note: "name reads like a mutation; confirm before probing",
  },
] as const;

export function selectProbeOps(
  includeUnconfirmed: boolean,
): readonly ProbeOp[] {
  return includeUnconfirmed ? PROBE_OPS : PROBE_OPS.filter((op) => op.readOnly);
}

export interface ProbeRequest {
  readonly operation: string;
  readonly url: string;
  readonly body: string;
}

/**
 * Build the in-page expression.
 *
 * Runs in the page context on purpose: the session cookie is HttpOnly, so the browser must attach it.
 * `JSON.stringify` carries the URL/body into the expression so quotes and newlines cannot break it.
 */
export function buildProbeExpression(
  request: ProbeRequest,
  previewChars = 2_000,
): string {
  const url = JSON.stringify(request.url);
  const body = JSON.stringify(request.body);
  const preview = Math.max(0, Math.trunc(previewChars));
  return `(async () => {
  // The edge wants the token the app stored after login. Read it in-page: it never crosses into Bun.
  let token = "";
  let customerID = "";
  try {
    const credentials = JSON.parse(sessionStorage.getItem("credentials") ?? "{}");
    token = credentials.code ?? "";
    customerID = credentials.customerID ?? "";
  } catch {}
  const headers = {
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    "x-requested-with": "XMLHttpRequest",
  };
  if (token) headers.authorization = "Bearer " + token;
  const resolvedBody = ${body}.replaceAll("{customerID}", encodeURIComponent(customerID));
  const response = await fetch(${url}, {
    method: "POST",
    credentials: "include",
    headers,
    body: resolvedBody,
  });
  const text = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    bytes: new TextEncoder().encode(text).byteLength,
    preview: text.slice(0, ${preview}),
  };
})()`;
}

export interface ProbePageResult {
  readonly status: number;
  readonly contentType: string;
  readonly bytes: number;
  readonly preview: string;
}

/** Validate what came back from the page before it is written as evidence. */
export function parseProbePageResult(raw: unknown): ProbePageResult {
  if (typeof raw !== "object" || raw === null)
    throw new Error("probe returned no object");
  const candidate = raw as Record<string, unknown>;
  const status = candidate["status"];
  const contentType = candidate["contentType"];
  const bytes = candidate["bytes"];
  const preview = candidate["preview"];
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100) {
    throw new Error("probe result has no HTTP status");
  }
  if (typeof contentType !== "string")
    throw new Error("probe result has no content type");
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) {
    throw new Error("probe result has no byte count");
  }
  if (typeof preview !== "string")
    throw new Error("probe result has no body preview");
  return { status, contentType, bytes, preview };
}

export type ProbeVerdict = "exists" | "denied" | "missing" | "error";

export function probeVerdict(status: number): ProbeVerdict {
  if (status >= 200 && status < 300) return "exists";
  if (status === 401 || status === 403) return "denied";
  if (status === 404 || status === 405) return "missing";
  return "error";
}

export function probeSummary(
  op: ProbeOp,
  result: ProbePageResult,
): { operation: string; verdict: ProbeVerdict; status: number; bytes: number } {
  return {
    operation: op.operation,
    verdict: probeVerdict(result.status),
    status: result.status,
    bytes: result.bytes,
  };
}

/**
 * Observed envelope from the 2026-10-31 captures: every Manager call is
 * `/cloud/api/Manager/<operation>`. The report names came from a third-party toolkit without that
 * prefix, so `/cloud/api/Report/<operation>` is the second candidate to test.
 */
export const PROBE_PREFIXES = [
  "/cloud/api/Manager",
  "/cloud/api/Report",
] as const;

/** The form body every observed Manager call uses; `agentOwner` defaults to the same agent. */
export function buildProbeBody(
  op: ProbeOp,
  agentId: string,
  customerId?: string,
): string {
  const params = new URLSearchParams();
  params.set("agentID", agentId);
  params.set("agentOwner", agentId);
  if (customerId !== undefined && customerId !== "")
    params.set("customerID", customerId);
  params.set("operation", op.operation);
  params.set("RRO", "1");
  return params.toString();
}

/** Absolute probe URL from a portal base and a route prefix; rejects non-http(s) bases. */
export function probeUrl(
  base: string,
  op: ProbeOp,
  prefix: string = PROBE_PREFIXES[0],
): string {
  const parsed = new URL(base);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`probe base must be http(s), got ${parsed.protocol}`);
  }
  if (!prefix.startsWith("/"))
    throw new Error(`probe prefix must start with /, got ${prefix}`);
  const root = `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`;
  return `${root}${prefix.replace(/\/$/, "")}/${op.operation}`;
}
