/**
 * Parse Manager `getDeletedTransactionHistory` responses (`{ LIST: [...] }`).
 * Ledger rows (deposits/withdrawals/adjustments), not deleted-wager legs.
 */

export interface DeletedLedgerRow {
  readonly Operation?: string;
  readonly DocumentNumber?: number;
  readonly CustomerID?: string;
  readonly TranDateTime?: string;
  readonly TranCode?: string;
  readonly TranType?: string;
  readonly Amount?: number;
  readonly PaymentBy?: string | null;
  readonly Description?: string;
  readonly EnteredBy?: string;
  readonly GradeNum?: unknown;
  readonly VerifiedFlag?: string | null;
  readonly HoldPercent?: number | null;
  readonly HoldAmount?: number | null;
  readonly ReleaseDate?: string | null;
  readonly CCNumber?: string | null;
  readonly CCExpires?: string | null;
  readonly CCApproval?: string | null;
  readonly EnteredAmount?: string | null;
  readonly CoverageDocumentNumber?: number | null;
  readonly Reference?: string | null;
  readonly DailyFigureDate?: string | null;
  readonly AgentID?: string;
  readonly LastUpdateDateTime?: string;
  readonly LastUpdateLoginID?: string;
}

export interface DeletedTransactionHistoryEnvelope {
  LIST: DeletedLedgerRow[];
}

export function parseDeletedTransactionHistoryEnvelope(
  raw: unknown,
): DeletedTransactionHistoryEnvelope {
  if (typeof raw !== "object" || raw === null)
    throw new Error("deleted transaction history envelope must be an object");
  const list = (raw as { LIST?: unknown }).LIST;
  if (!Array.isArray(list)) throw new Error("LIST must be an array");
  return { LIST: list as DeletedLedgerRow[] };
}

export function trimCustomerId(raw: string | undefined): string {
  return (raw ?? "").trim();
}

export interface DeletedLedgerSummary {
  readonly rowCount: number;
  readonly customerIds: string[];
  readonly documentNumbers: number[];
  readonly newestTranDateTime: string | null;
}

export function summarizeDeletedTransactionHistory(
  envelope: DeletedTransactionHistoryEnvelope,
): DeletedLedgerSummary {
  const customerSet = new Set<string>();
  const documentNumbers: number[] = [];
  let newest: string | null = null;
  for (const row of envelope.LIST) {
    const cid = trimCustomerId(row.CustomerID);
    if (cid) customerSet.add(cid);
    if (typeof row.DocumentNumber === "number")
      documentNumbers.push(row.DocumentNumber);
    const dt = (row.TranDateTime ?? "").trim();
    if (dt && (newest === null || dt > newest)) newest = dt;
  }
  documentNumbers.sort((a, b) => b - a);
  return {
    rowCount: envelope.LIST.length,
    customerIds: [...customerSet].sort(),
    documentNumbers,
    newestTranDateTime: newest,
  };
}

/** Wire probe target for replaying the same customer-admin read. */
export function probeCustomerForHistory(
  envelope: DeletedTransactionHistoryEnvelope,
): string | null {
  const first = envelope.LIST[0];
  if (!first) return null;
  const id = trimCustomerId(first.CustomerID);
  return id || null;
}
