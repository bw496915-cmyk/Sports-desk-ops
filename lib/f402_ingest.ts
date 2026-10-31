/**
 * @file lib/f402_ingest.ts
 * @description Read-only F402 connectivity probe over a cached session.
 *
 * Uses `POST /cloud/api/Manager/getBetTicker` (tier A: live request+response captured) to prove the
 * session works, count rows, and normalize the captured identity/timing fields into a tick preview.
 * Money fields are deliberately not mapped: their units are unverified, so the preview carries no
 * stake/payout values.
 */

import type { F402Session } from "./f402_session.ts";

export interface F402ProbeOptions {
  readonly baseUrl?: string;
  readonly agentId: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface F402TickerRow {
  readonly login: string;
  readonly customerId: string;
  readonly agentId: string;
  readonly agentLogin: string;
  readonly ticketWriter: string;
  readonly wagerNumber: string;
  readonly wagerType: string;
  readonly shortDesc: string;
  readonly insertedAt: string;
  readonly vip: string;
}

export interface F402Probe {
  readonly endpoint: string;
  readonly httpStatus: number;
  readonly rows: number;
  readonly fields: readonly string[];
  readonly ticks: readonly F402TickerRow[];
  readonly durationMs: number;
  readonly fetchedAtIso: string;
  readonly error: string | null;
}

function extractRows(body: unknown): readonly unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body === null || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  for (const key of ["LIST", "data", "rows"]) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

const text = (value: unknown): string =>
  typeof value === "string"
    ? value.trim()
    : typeof value === "number"
      ? String(value)
      : "";

const cleanText = (value: unknown): string =>
  text(value)
    .replace(/[^\x20-\x7E\u00BD]/g, "")
    .trim();

/** Normalizes the captured identity/timing fields; money fields are omitted on purpose. */
export function parseF402TickerRow(value: unknown): F402TickerRow | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const login = text(row.Login) || text(row.CustomerID);
  if (login === "") return null;
  return {
    login,
    customerId: text(row.CustomerID),
    agentId: text(row.AgentID),
    agentLogin: text(row.AgentLogin),
    ticketWriter: text(row.TicketWriter),
    wagerNumber: text(row.WagerNumber),
    wagerType: text(row.WagerType),
    shortDesc: cleanText(row.ShortDesc),
    insertedAt: text(row.InsertDateTime),
    vip: text(row.VIP),
  };
}

/**
 * Probes `getBetTicker` with the captured form shape. 401/403 returns `error: "unauthorized"` so the
 * caller can refresh the session once.
 */
export async function probeF402BetTicker(
  session: F402Session,
  options: F402ProbeOptions,
): Promise<F402Probe> {
  const startedAt = Date.now();
  const fetchedAtIso = new Date(startedAt).toISOString();
  const baseUrl = (options.baseUrl ?? "https://fantasy402.com").replace(
    /\/$/,
    "",
  );
  const endpoint = `${baseUrl}/cloud/api/Manager/getBetTicker`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const agentId = options.agentId.trim();

  const body = new URLSearchParams({
    RRO: "0",
    agentID: agentId,
    agentOwner: agentId,
    operation: "getBetTicker",
    wagerNumber: "0",
  });

  const headers: Record<string, string> = {
    accept: "application/json",
    "x-requested-with": "XMLHttpRequest",
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    cookie: session.cookieHeader,
  };
  if (session.authorizationHeader !== undefined) {
    headers["authorization"] = session.authorizationHeader;
  }

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body,
      proxy: false,
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    } as RequestInit);
    const durationMs = Date.now() - startedAt;
    if (!response.ok) {
      return {
        endpoint,
        httpStatus: response.status,
        rows: 0,
        fields: [],
        ticks: [],
        durationMs,
        fetchedAtIso,
        error:
          response.status === 401 || response.status === 403
            ? "unauthorized"
            : `HTTP ${response.status}`,
      };
    }
    const parsed: unknown = await response.json();
    const rows = extractRows(parsed);
    const ticks = (rows ?? [])
      .map(parseF402TickerRow)
      .filter((tick): tick is F402TickerRow => tick !== null)
      .slice(0, 200);
    const firstRow = rows?.[0];
    const fields =
      firstRow !== null && typeof firstRow === "object"
        ? Object.keys(firstRow as Record<string, unknown>).sort()
        : [];
    return {
      endpoint,
      httpStatus: response.status,
      rows: rows?.length ?? 0,
      fields,
      ticks,
      durationMs,
      fetchedAtIso,
      error: rows === null ? "unexpected body" : null,
    };
  } catch (error) {
    const message =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
        ? "timeout"
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      endpoint,
      httpStatus: 0,
      rows: 0,
      fields: [],
      ticks: [],
      durationMs: Date.now() - startedAt,
      fetchedAtIso,
      error: message,
    };
  }
}
