/**
 * @file lib/f402_ingest.ts
 * @description Read-only F402 connectivity probe over a cached session.
 *
 * Uses `POST /cloud/api/Manager/getBetTicker` (tier A: live request+response captured) to prove the
 * session works and count returned tick rows. Mapping rows into the feed is intentionally not done
 * here: the pending-bet mapping needs its own captured contract.
 */

import type { F402Session } from "./f402_session.ts";

export interface F402ProbeOptions {
  readonly baseUrl?: string;
  readonly agentId: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface F402Probe {
  readonly endpoint: string;
  readonly httpStatus: number;
  readonly rows: number;
  readonly durationMs: number;
  readonly fetchedAtIso: string;
  readonly error: string | null;
}

function countRows(body: unknown): number | null {
  if (Array.isArray(body)) return body.length;
  if (body === null || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  for (const key of ["LIST", "data", "rows"]) {
    const value = record[key];
    if (Array.isArray(value)) return value.length;
  }
  return null;
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
  const baseUrl = (options.baseUrl ?? "https://fantasy402.com").replace(/\/$/, "");
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
        durationMs,
        fetchedAtIso,
        error: response.status === 401 || response.status === 403 ? "unauthorized" : `HTTP ${response.status}`,
      };
    }
    const parsed: unknown = await response.json();
    const rows = countRows(parsed);
    return {
      endpoint,
      httpStatus: response.status,
      rows: rows ?? 0,
      durationMs,
      fetchedAtIso,
      error: rows === null ? "unexpected body" : null,
    };
  } catch (error) {
    const message =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
        ? "timeout"
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      endpoint,
      httpStatus: 0,
      rows: 0,
      durationMs: Date.now() - startedAt,
      fetchedAtIso,
      error: message,
    };
  }
}
