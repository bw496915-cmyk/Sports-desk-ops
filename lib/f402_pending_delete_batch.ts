/**
 * In-page batch PendingDelete fetches (one WebView login, one evaluate per customer).
 */

import {
  F402_FORM_WIRE_CONTENT_TYPE,
  inPageCloudApiHeadersJs,
  inPageInjectWireTokenJs,
  inPageCollectResponseHeadersJs,
  inPageReadSessionAuthJs,
} from "./f402_in_page_fetch.ts";
import {
  buildProbeBody,
  type ProbeOp,
  PROBE_OPS,
  type ProbeWireContentType,
} from "./f402_probe.ts";

export interface PendingDeleteBatchItem {
  readonly ticketNumber: string;
  readonly body: string;
}

export interface PendingDeleteBatchRow {
  readonly ticketNumber: string;
  readonly status: number;
  readonly bytes: number;
  readonly bodyText: string;
  readonly cfRay?: string;
  readonly responseHeaders?: Record<string, string>;
}

const PASSWORD_FIELD = /"Password"\s*:\s*"[^"]*"/g;

export function pendingDeleteProbeOp(): ProbeOp {
  const op = PROBE_OPS.find((row) => row.operation === "PendingDelete");
  if (!op) throw new Error("PendingDelete missing from PROBE_OPS");
  return op;
}

export function buildPendingDeleteBodies(
  agentId: string,
  customerId: string,
  ticketNumbers: readonly string[],
): PendingDeleteBatchItem[] {
  const op = pendingDeleteProbeOp();
  return ticketNumbers.map((ticketNumber) => ({
    ticketNumber,
    body: buildProbeBody(op, agentId, customerId.trim(), { ticketNumber }),
  }));
}

/**
 * One token/date setup, sequential fetch() per ticket (HttpOnly cookies stay in-page).
 */
export function buildBatchPendingDeleteExpression(
  url: string,
  items: readonly PendingDeleteBatchItem[],
  contentType: ProbeWireContentType = F402_FORM_WIRE_CONTENT_TYPE,
  previewChars = 500,
): string {
  const urlLit = JSON.stringify(url);
  const itemsLit = JSON.stringify(items);
  const preview = Math.max(0, Math.trunc(previewChars));
  const isJson = contentType === "application/json";

  return `(async () => {
  ${inPageReadSessionAuthJs()}
  ${inPageCloudApiHeadersJs(contentType)}
  const items = ${itemsLit};
  const results = [];
  for (const item of items) {
    let resolvedBody = item.body;
    ${inPageInjectWireTokenJs(isJson)}
    let status = 0;
    let bodyText = "";
    let cfRay = "";
    let responseHeaders = {};
    try {
      const response = await fetch(${urlLit}, {
        method: "POST",
        credentials: "include",
        headers,
        body: resolvedBody,
      });
      status = response.status;
      bodyText = await response.text();
      ${inPageCollectResponseHeadersJs(true)}
    } catch (err) {
      bodyText = String(err && err.message ? err.message : err);
    }
    results.push({
      ticketNumber: item.ticketNumber,
      status,
      bytes: bodyText.length,
      bodyText,
      cfRay,
      responseHeaders,
      preview: bodyText.slice(0, ${preview}),
    });
  }
  return results;
})()`;
}

export function countPendingInResponseText(text: string): number {
  if (!text.includes('"Pending"')) return 0;
  if (/"Pending"\s*:\s*\[\s*\]/.test(text)) return 0;
  try {
    const parsed = JSON.parse(text) as { Pending?: unknown[] };
    if (Array.isArray(parsed.Pending)) return parsed.Pending.length;
  } catch {
    // fall through
  }
  return (text.match(/"TicketNumber"\s*:/g) ?? []).length;
}

/** Strip wager passwords before persisting probe previews. */
export function redactPendingDeletePreview(text: string): string {
  return text.replace(PASSWORD_FIELD, '"Password":"<redacted>"');
}

export function parsePendingDeleteBatchRows(
  raw: unknown,
): PendingDeleteBatchRow[] {
  if (!Array.isArray(raw))
    throw new Error("batch PendingDelete result must be an array");
  const rows: PendingDeleteBatchRow[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const ticketNumber = row["ticketNumber"];
    const status = row["status"];
    const bodyText = row["bodyText"];
    if (typeof ticketNumber !== "string" || typeof status !== "number")
      continue;
    if (typeof bodyText !== "string") continue;
    const responseHeaders = row["responseHeaders"];
    rows.push({
      ticketNumber,
      status,
      bytes: typeof row["bytes"] === "number" ? row["bytes"] : bodyText.length,
      bodyText,
      ...(typeof row["cfRay"] === "string" && row["cfRay"] !== ""
        ? { cfRay: row["cfRay"] }
        : {}),
      ...(typeof responseHeaders === "object" &&
      responseHeaders !== null &&
      !Array.isArray(responseHeaders)
        ? { responseHeaders: responseHeaders as Record<string, string> }
        : {}),
    });
  }
  return rows;
}
