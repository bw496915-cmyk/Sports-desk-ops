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

export type ProbeParam =
  | "agentID"
  | "customerID"
  | "week"
  | "date"
  | "token"
  | "operation"
  | "ticketNumber"
  | "wagerNumber"
  | "flag"
  | "agentType"
  | "RRO"
  | "agentOwner";

export interface ProbeOp {
  readonly operation: string;
  readonly method: "POST";
  /** False for operations whose read-only nature has not been confirmed. */
  readonly readOnly: boolean;
  readonly note: string;
  /** Form fields the client sends, read from `customer/report/report.js`. */
  readonly params: readonly ProbeParam[];
}

export const PROBE_OPS: readonly ProbeOp[] = [
  {
    operation: "Pending",
    method: "POST",
    readOnly: true,
    note: "already in the capture allowlist as getPending",
    params: ["customerID", "token", "operation"],
  },
  {
    operation: "getDailyFiguresByCustomer",
    method: "POST",
    readOnly: true,
    note: "daily figure report read",
    params: ["agentID", "customerID", "week", "token", "operation"],
  },
  {
    operation: "getGradedWagerByCustomer",
    method: "POST",
    readOnly: true,
    note: "graded wager report read",
    params: ["customerID", "week", "token", "operation"],
  },
  {
    operation: "getTransactions",
    method: "POST",
    readOnly: true,
    note: "transaction report read; `date` is MM/DD/YYYY",
    params: ["customerID", "date", "token", "operation"],
  },
  {
    operation: "getGrading",
    method: "POST",
    readOnly: true,
    note: "grading report read; also settles the channel model",
    params: ["customerID", "token", "operation"],
  },
  {
    operation: "getTicketDetailPrint",
    method: "POST",
    readOnly: true,
    note: "ticket detail read; needs a ticket/wager number (portal sends ticketNumber, wagerNumber, flag)",
    params: ["token", "ticketNumber", "wagerNumber", "flag", "operation"],
  },
  {
    operation: "getListAgenstByAgent",
    method: "POST",
    readOnly: true,
    note: "agent list by agent (Manager envelope); form: agentID, agentType, operation, RRO, agentOwner",
    params: ["agentID", "agentType", "operation", "RRO", "agentOwner"],
  },
  {
    operation: "PendingDelete",
    method: "POST",
    readOnly: false,
    note: "name reads like a mutation; confirm before probing",
    params: ["customerID", "token", "operation"],
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
  weekValue?: string,
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
  // Yesterday: today's date is not a settled day for this endpoint (it answers 500).
  const now = new Date(Date.now() - 86_400_000);
  const mdy = String(now.getMonth() + 1).padStart(2, "0") + "/" + String(now.getDate()).padStart(2, "0") + "/" + now.getFullYear();
  // Optional week override: an integer index, a date string, or any candidate the probe wants to try.
  // Empty string keeps the historical default (yesterday's date) so existing captures stay comparable.
  // The portal's own client sends an integer week index (0 = current week, 1..N weeks ago),
  // not a date string. Default to "0"; a caller may override with --week.
  const weekOverride = ${JSON.stringify(weekValue ?? "")};
  const weekValueResolved = weekOverride !== "" ? weekOverride : "0";
  const resolvedBody = ${body}
    .replaceAll("__CUSTOMER_ID__", encodeURIComponent(customerID))
    .replaceAll("__DATE__", encodeURIComponent(mdy))
    .replaceAll("__WEEK__", encodeURIComponent(weekValueResolved));
  const response = await fetch(${url}, {
    method: "POST",
    credentials: "include",
    headers,
    body: resolvedBody,
  });
  // Read bytes once: text.length counts characters, and re-encoding the whole body just to measure it
  // is wasted work. The preview decodes a prefix; bodyText stays for the promote path.
  const buffer = new Uint8Array(await response.arrayBuffer());
  const decoder = new TextDecoder();
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    bytes: buffer.byteLength,
    preview: decoder.decode(buffer.subarray(0, ${preview})),
    bodyText: decoder.decode(buffer),
    dateUsed: mdy,
    weekUsed: weekValueResolved,
  };
})()`;
}

export interface SniffedFormTemplate {
  readonly path: string;
  readonly method: string;
  readonly formKeys: readonly string[];
}

/**
 * In-page `XMLHttpRequest` + `fetch` sniffer expression for WebKit and Chrome.
 *
 * Because `backend: "webkit"` (`WKWebView`) has no CDP bridge, this hook intercepts outbound
 * `/cloud/api/` calls directly inside the page and records **only** the URL pathname, HTTP method,
 * and sorted URL-encoded form parameter names (`formKeys`) — parameter values never leave the page.
 */
export function buildInstallRequestSnifferExpression(): string {
  return `(() => {
  if (window.__f402SnifferInstalled) return true;
  window.__f402SnifferInstalled = true;
  window.__f402SniffedRequests = window.__f402SniffedRequests || [];
  const parseKeys = (raw) => {
    if (typeof raw !== "string" || raw.trim() === "") return [];
    const out = new Set();
    for (const [k] of new URLSearchParams(raw)) {
      if (k.trim() !== "") out.add(k.trim());
    }
    return Array.from(out).sort();
  };
  const record = (rawUrl, rawMethod, rawBody) => {
    try {
      const parsed = new URL(String(rawUrl), location.origin);
      if (!parsed.pathname.includes("/cloud/api/")) return;
      window.__f402SniffedRequests.push({
        path: parsed.pathname,
        method: String(rawMethod || "POST").toUpperCase(),
        formKeys: parseKeys(rawBody),
      });
    } catch {}
  };
  const proto = XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const origSend = proto.send;
  proto.open = function (method, url) {
    this.__f402Method = method;
    this.__f402Url = url;
    return origOpen.apply(this, arguments);
  };
  proto.send = function (body) {
    record(this.__f402Url, this.__f402Method, typeof body === "string" ? body : "");
    return origSend.apply(this, arguments);
  };
  if (typeof window.fetch === "function") {
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const method = (init && init.method) || (input && input.method) || "GET";
      const body = init && typeof init.body === "string" ? init.body : "";
      record(url, method, body);
      return origFetch.apply(this, arguments);
    };
  }
  return true;
})()`;
}

/** Read the in-page sniffed `/cloud/api/` request templates collected on WebKit or Chrome. */
export function buildReadRequestSnifferExpression(): string {
  return `(() => Array.isArray(window.__f402SniffedRequests) ? window.__f402SniffedRequests : [])()`;
}

/** Validate and deduplicate sniffed form templates returned from the page or CDP. */
export function parseSniffedTemplates(raw: unknown): SniffedFormTemplate[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SniffedFormTemplate[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;
    const path = candidate["path"];
    const method = candidate["method"];
    const formKeys = candidate["formKeys"];
    if (
      typeof path !== "string" ||
      !path.startsWith("/") ||
      typeof method !== "string" ||
      !Array.isArray(formKeys) ||
      !formKeys.every((key) => typeof key === "string")
    ) {
      continue;
    }
    const sortedKeys = [...(formKeys as string[])].sort();
    const signature = `${method.toUpperCase()} ${path} ${sortedKeys.join(",")}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    out.push({
      path,
      method: method.toUpperCase(),
      formKeys: sortedKeys,
    });
  }
  return out;
}

export interface ProbePageResult {
  readonly status: number;
  readonly contentType: string;
  readonly bytes: number;
  readonly preview: string;
  readonly bodyText?: string;
  readonly dateUsed?: string;
  readonly weekUsed?: string;
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
  const bodyText = candidate["bodyText"];
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
  const dateUsed = candidate["dateUsed"];
  const weekUsed = candidate["weekUsed"];
  return {
    status,
    contentType,
    bytes,
    preview,
    ...(typeof bodyText === "string" ? { bodyText } : {}),
    ...(typeof dateUsed === "string" ? { dateUsed } : {}),
    ...(typeof weekUsed === "string" ? { weekUsed } : {}),
  };
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

/**
 * Build the form body from the fields the client actually sends.
 *
 * `customerID`, `date` and `week` stay as placeholders: the page resolves them from sessionStorage and
 * the local date, so the value never has to cross into Bun. `token` is empty because `Security.token`
 * is empty in the browser session — the edge accepts the bearer instead.
 */
export interface ProbeBodyOptions {
  readonly ticketNumber?: string;
  readonly wagerNumber?: string;
  readonly flag?: string;
}

export function buildProbeBody(
  op: ProbeOp,
  agentId: string,
  customerId?: string,
  options: ProbeBodyOptions = {},
): string {
  const params = new URLSearchParams();
  for (const name of op.params) {
    if (name === "operation") {
      params.set("operation", op.operation);
    } else if (name === "agentID") {
      params.set("agentID", agentId);
    } else if (name === "token") {
      params.set("token", "");
    } else if (name === "customerID") {
      params.set(
        "customerID",
        customerId !== undefined && customerId !== ""
          ? customerId
          : "__CUSTOMER_ID__",
      );
    } else if (name === "date") {
      params.set("date", "__DATE__");
    } else if (name === "week") {
      params.set("week", "__WEEK__");
    } else if (name === "ticketNumber") {
      params.set("ticketNumber", options.ticketNumber ?? "0");
    } else if (name === "wagerNumber") {
      params.set("wagerNumber", options.wagerNumber ?? "0");
    } else if (name === "flag") {
      params.set("flag", options.flag ?? "");
    } else if (name === "agentType") {
      params.set("agentType", "M");
    } else if (name === "RRO") {
      params.set("RRO", "1");
    } else if (name === "agentOwner") {
      params.set("agentOwner", agentId);
    }
  }
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
