/**
 * In-page expressions to find tickets that return non-empty PendingDelete payloads.
 */

import {
  F402_CLOUD_API_ACCEPT,
  F402_FORM_WIRE_CONTENT_TYPE,
} from "../../lib/f402_in_page_fetch.ts";

export function pendingDeleteHuntExpression(
  baseUrl: string,
  customerId: string,
  maxCandidates = 8,
): string {
  const origin = baseUrl.replace(/\/$/, "");
  return `(async () => {
  const creds = JSON.parse(sessionStorage.getItem("credentials") ?? "{}");
  const auth = "Bearer " + (creds.code ?? "");
  const headers = {
    accept: ${JSON.stringify(F402_CLOUD_API_ACCEPT)},
    "content-type": ${JSON.stringify(F402_FORM_WIRE_CONTENT_TYPE)},
    "x-requested-with": "XMLHttpRequest",
    authorization: auth,
  };
  const post = async (body) => {
    const r = await fetch(${JSON.stringify(origin)} + "/cloud/api/Report/PendingDelete", {
      method: "POST",
      credentials: "include",
      headers,
      body: new URLSearchParams(body).toString(),
    });
    const text = await r.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch {}
    const legs = Array.isArray(payload?.Pending) ? payload.Pending.length : 0;
    return { status: r.status, legs, payloadOk: payload !== null };
  };
  const pendingBody = new URLSearchParams({
    customerID: ${JSON.stringify(customerId)},
    token: "",
    operation: "Pending",
  }).toString();
  const pr = await fetch(${JSON.stringify(origin)} + "/cloud/api/Report/Pending", {
    method: "POST",
    credentials: "include",
    headers,
    body: pendingBody,
  });
  const pt = await pr.text();
  let pendingPayload;
  try { pendingPayload = JSON.parse(pt); } catch { return { error: "pending-not-json" }; }
  const rows = Array.isArray(pendingPayload.Pending) ? pendingPayload.Pending : [];
  const candidates = [];
  for (let i = 0; i < rows.length && candidates.length < ${maxCandidates}; i++) {
    const row = rows[i];
    if (!row || typeof row !== "object") continue;
    const ticketNumber = String(row.TicketNumber ?? "").trim();
    const wagerNumber = String(row.WagerNumber ?? "").trim();
    if (ticketNumber === "" || wagerNumber === "") continue;
    const wagerType = String(row.WagerType ?? "").trim();
    const probe = await post({
      customerID: ${JSON.stringify(customerId)},
      ticketNumber,
      token: creds.code ?? "",
      operation: "PendingDelete",
    });
    candidates.push({
      ticketNumber,
      wagerNumber,
      flag: wagerType,
      pendingDeleteStatus: probe.status,
      pendingDeleteLegs: probe.legs,
    });
    if (probe.legs > 0) {
      return {
        customerId: ${JSON.stringify(customerId)},
        pendingRowCount: rows.length,
        hit: {
          customerId: ${JSON.stringify(customerId)},
          ticketNumber,
          wagerNumber,
          flag: wagerType,
          pendingDeleteLegs: probe.legs,
        },
        candidates,
      };
    }
  }
  return {
    customerId: ${JSON.stringify(customerId)},
    pendingRowCount: rows.length,
    hit: null,
    candidates,
  };
})()`;
}
