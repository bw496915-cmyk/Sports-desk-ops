/**
 * Parse Manager `getInfoPlayer` responses (`{ INFO: { data, balance, … } }`).
 * Response bodies may include credentials-adjacent fields; use {@link redactGetInfoPlayer}
 * before logging or writing scratch artifacts.
 */

export interface ParlaySpecRow {
  readonly ParlayName?: string;
  readonly MaxPicks?: number;
  readonly DefaultPrice?: number;
  readonly ParlayDescription?: string | null;
  readonly ParlayDisplayName?: string | null;
}

export interface GetInfoPlayerData {
  readonly Login?: string;
  readonly AgentType?: string;
  readonly Active?: string;
  readonly CreditLimit?: number;
  readonly CurrentBalance?: number;
  readonly PendingWagerBalance?: number;
  readonly PendingWagerCount?: number;
  readonly ParlayName?: string;
  readonly Currency?: string;
  readonly [key: string]: unknown;
}

export interface GetInfoPlayerEnvelope {
  readonly INFO: {
    readonly data: GetInfoPlayerData;
    readonly balance?: { readonly AvailableBalance?: number };
    readonly totalNonPostedCasino?: { readonly TotalAmount?: number | null };
    readonly added?: {
      readonly CustomerID?: string;
      readonly RebatePercent?: number;
      readonly NotifyTelegram?: string;
      readonly [key: string]: unknown;
    };
    readonly thisWeek?: boolean;
    readonly parlaySpecs?: ParlaySpecRow[];
  };
}

const SENSITIVE_INFO_DATA_KEYS = new Set([
  "Password",
  "Passwordt",
  "EncryptTempPassExpiredDate",
]);

export function trimPaddedId(raw: string | undefined): string {
  return (raw ?? "").trim();
}

export function parseGetInfoPlayerEnvelope(raw: unknown): GetInfoPlayerEnvelope {
  if (typeof raw !== "object" || raw === null)
    throw new Error("getInfoPlayer envelope must be an object");
  const info = (raw as { INFO?: unknown }).INFO;
  if (typeof info !== "object" || info === null)
    throw new Error("INFO must be an object");
  const data = (info as { data?: unknown }).data;
  if (typeof data !== "object" || data === null)
    throw new Error("INFO.data must be an object");
  const parlaySpecs = (info as { parlaySpecs?: unknown }).parlaySpecs;
  if (
    parlaySpecs !== undefined &&
    parlaySpecs !== null &&
    !Array.isArray(parlaySpecs)
  ) {
    throw new Error("INFO.parlaySpecs must be an array when present");
  }
  return raw as GetInfoPlayerEnvelope;
}

/** Strip password-like fields from a parsed envelope (mutates a shallow copy). */
export function redactGetInfoPlayer(
  envelope: GetInfoPlayerEnvelope,
): GetInfoPlayerEnvelope {
  const data = { ...envelope.INFO.data };
  for (const key of SENSITIVE_INFO_DATA_KEYS) {
    if (key in data) data[key] = "<redacted>";
  }
  return {
    INFO: {
      ...envelope.INFO,
      data,
    },
  };
}

export interface GetInfoPlayerSummary {
  readonly customerId: string;
  readonly login: string;
  readonly agentType: string | null;
  readonly active: string | null;
  readonly creditLimit: number | null;
  readonly currentBalance: number | null;
  readonly availableBalance: number | null;
  readonly pendingWagerCount: number | null;
  readonly assignedParlayName: string | null;
  readonly parlaySpecCount: number;
}

export function summarizeGetInfoPlayer(
  envelope: GetInfoPlayerEnvelope,
): GetInfoPlayerSummary {
  const { data, balance, added, parlaySpecs } = envelope.INFO;
  const customerId =
    trimPaddedId(added?.CustomerID) || trimPaddedId(data.Login) || "";
  return {
    customerId,
    login: trimPaddedId(data.Login),
    agentType: data.AgentType ?? null,
    active: data.Active ?? null,
    creditLimit: typeof data.CreditLimit === "number" ? data.CreditLimit : null,
    currentBalance:
      typeof data.CurrentBalance === "number" ? data.CurrentBalance : null,
    availableBalance:
      typeof balance?.AvailableBalance === "number"
        ? balance.AvailableBalance
        : null,
    pendingWagerCount:
      typeof data.PendingWagerCount === "number"
        ? data.PendingWagerCount
        : null,
    assignedParlayName: trimPaddedId(data.ParlayName) || null,
    parlaySpecCount: parlaySpecs?.length ?? 0,
  };
}
