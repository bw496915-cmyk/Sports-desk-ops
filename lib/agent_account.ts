/**
 * @file lib/agent_account.ts
 * @description Project getAccountInfoOwner / getConfigWebReports into a sanitized config record.
 * The raw responses carry a JWT (`code`), passwords and names; none of those survive projection.
 */

const SENSITIVE = new Set([
  "code",
  "password",
  "passwordfix",
  "namefirst",
  "namelast",
  "playername",
  "email",
  "phone",
  "smsphonenumber",
  "commentsforcustomer",
]);

const trim = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE.has(key.toLowerCase())) continue;
    out[key] = scrub(child);
  }
  return out;
}

export interface ProjectedAccountConfig {
  readonly schemaVersion: 1;
  readonly agentId: string | null;
  readonly office: string | null;
  readonly store: string | null;
  readonly agentType: string | null;
  readonly serverDate: string | null;
  readonly timeZone: number | null;
  readonly displayFlags: Readonly<Record<string, string>>;
  readonly preferences: readonly unknown[];
  readonly projectedAt: string;
}

export function projectAccountInfoOwner(raw: unknown): ProjectedAccountConfig {
  if (raw === null || typeof raw !== "object")
    throw new Error("account response must be an object");
  const doc = raw as Record<string, unknown>;
  const infoRaw = doc.accountInfo;
  if (
    infoRaw === null ||
    typeof infoRaw !== "object" ||
    Array.isArray(infoRaw)
  ) {
    throw new Error("account response lacks accountInfo");
  }
  const info = infoRaw as Record<string, unknown>;
  const safe = scrub(info) as Record<string, unknown>;
  const displayFlags: Record<string, string> = {};
  for (const [key, value] of Object.entries(safe)) {
    if (/^show/i.test(key) && typeof value === "string")
      displayFlags[key] = value;
  }
  const server = doc.SERVER as Record<string, unknown> | undefined;
  const prefs = Array.isArray(doc.preferenceDate)
    ? scrub(doc.preferenceDate)
    : [];
  return {
    schemaVersion: 1,
    agentId: trim(info.customerID) ?? trim(info.AgentID),
    office: trim(info.Office),
    store: trim(info.Store),
    agentType: trim(info.AgentType),
    serverDate: trim(server?.date),
    timeZone: typeof info.TimeZone === "number" ? info.TimeZone : null,
    displayFlags,
    preferences: Array.isArray(prefs) ? prefs : [],
    projectedAt: new Date().toISOString(),
  };
}
