/**
 * Parse Manager `getCustomerAdmin` responses (`{ LIST: [...] }`).
 * Rows are customer-admin grid lines (balances, limits, login metadata).
 * **`Password` is plaintext on the wire — redact before logging or fixtures.**
 */

export interface CustomerAdminListRow {
  readonly MasterAgent?: string;
  readonly CustomerID?: string;
  readonly AgentID?: string;
  readonly Login?: string;
  readonly Name?: string;
  readonly Password?: string;
  readonly CurrentBalance?: string;
  readonly CreditLimit?: string;
  readonly WagerLimit?: string;
  readonly PendingWagerBalance?: string;
  readonly AvailableBalance?: string;
  readonly AgentLogin?: string;
  readonly ReadOnlyFlag?: string;
  readonly Active?: string;
  readonly PlayerNotes?: string;
  readonly [key: string]: unknown;
}

export interface CustomerAdminListEnvelope {
  readonly LIST: CustomerAdminListRow[];
}

export function trimPaddedField(raw: string | undefined): string {
  return (raw ?? "").trim();
}

export function parseCustomerAdminListEnvelope(
  raw: unknown,
): CustomerAdminListEnvelope {
  if (typeof raw !== "object" || raw === null)
    throw new Error("getCustomerAdmin envelope must be an object");
  const list = (raw as { LIST?: unknown }).LIST;
  if (!Array.isArray(list)) throw new Error("LIST must be an array");
  return { LIST: list as CustomerAdminListRow[] };
}

const REDACTED_LIST_FIELDS = new Set(["Password"]);

/** Shallow copy rows with `Password` replaced (for scratch JSON / logs). */
export function redactCustomerAdminListEnvelope(
  envelope: CustomerAdminListEnvelope,
): CustomerAdminListEnvelope {
  return {
    LIST: envelope.LIST.map((row) => {
      const copy = { ...row };
      for (const key of REDACTED_LIST_FIELDS) {
        if (key in copy) (copy as Record<string, unknown>)[key] = "<redacted>";
      }
      return copy;
    }),
  };
}

export interface CustomerAdminListSummary {
  readonly rowCount: number;
  readonly agentIds: string[];
  readonly customerIds: string[];
  readonly totalPendingWagerBalance: number;
  readonly rowsWithPending: number;
}

function parseAmount(raw: string | undefined): number {
  const n = Number.parseFloat((raw ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

export function summarizeCustomerAdminList(
  envelope: CustomerAdminListEnvelope,
): CustomerAdminListSummary {
  const agentSet = new Set<string>();
  const customerIds: string[] = [];
  let totalPending = 0;
  let rowsWithPending = 0;

  for (const row of envelope.LIST) {
    const agent = trimPaddedField(row.AgentID);
    if (agent) agentSet.add(agent);
    const cid = trimPaddedField(row.CustomerID);
    if (cid) customerIds.push(cid);
    const pending = parseAmount(row.PendingWagerBalance);
    if (pending !== 0) rowsWithPending += 1;
    totalPending += pending;
  }

  customerIds.sort();
  return {
    rowCount: envelope.LIST.length,
    agentIds: [...agentSet].sort(),
    customerIds,
    totalPendingWagerBalance: totalPending,
    rowsWithPending,
  };
}
