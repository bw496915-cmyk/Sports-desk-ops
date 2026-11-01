/**
 * Parse Manager deleted-transactions report rows (`INFO.LIST` envelope).
 * One row per parlay leg; dedupe to unique tickets for PendingDelete probes.
 */

export interface DeletedWagerLegRow {
  // Canonical (legacy) field names:
  readonly TicketNumber?: string;
  readonly customerID?: string;
  readonly Login?: string;
  readonly DeleteDateTime?: string;
  readonly AmountWagered?: string;
  readonly WagerType?: string;
  readonly WagerCount?: string | null;
  readonly totalPicks?: string | null;
  readonly LoginID?: string;
  readonly NameFirst?: string;
  readonly Password?: string;
  // Real deleted-transactions report field names (DocumentNumber payload):
  readonly DocumentNumber?: number | string;
  readonly CustomerID?: string;
  readonly AgentID?: string;
  readonly TranCode?: string;
  readonly TranType?: string;
  readonly TranDateTime?: string;
  readonly Amount?: string | number;
  readonly EnteredAmount?: string | number;
  readonly EnteredBy?: string;
  readonly LastUpdateLoginID?: string;
  readonly Description?: string;
  readonly Operation?: string;
}

export interface DeletedWagerTicketTarget {
  readonly ticketNumber: string;
  readonly customerId: string;
  readonly login: string;
  readonly deleteDateTime: string;
  readonly legCount: number;
  readonly amountWagered: string;
  readonly wagerType: string;
  readonly loginId: string;
  readonly nameFirst: string;
}

export interface DeletedWagerListEnvelope {
  INFO: {
    LIST: DeletedWagerLegRow[];
  };
}

const STRIP_FIELDS = new Set(["Password"]);

/** Remove credential fields before writing fixtures to disk. */
export function redactDeletedWagerEnvelope(
  envelope: DeletedWagerListEnvelope,
): DeletedWagerListEnvelope {
  return {
    INFO: {
      LIST: envelope.INFO.LIST.map((row) => {
        const out: Record<string, unknown> = { ...row };
        for (const key of STRIP_FIELDS) delete out[key];
        return out as unknown as DeletedWagerLegRow;
      }),
    },
  };
}

export function parseDeletedWagerEnvelope(
  raw: unknown,
): DeletedWagerListEnvelope {
  if (typeof raw !== "object" || raw === null)
    throw new Error("deleted wager envelope must be an object");
  const info = (raw as { INFO?: unknown }).INFO;
  if (typeof info !== "object" || info === null)
    throw new Error("deleted wager envelope missing INFO");
  const list = (info as { LIST?: unknown }).LIST;
  if (!Array.isArray(list)) throw new Error("INFO.LIST must be an array");
  return { INFO: { LIST: list as DeletedWagerLegRow[] } };
}

function trimCustomerId(raw: string): string {
  return raw.trim();
}

function trimLogin(raw: string): string {
  return raw.trim();
}

/** Resolve the ticket id from either canonical or real-payload field names. */
function ticketNumberOf(row: DeletedWagerLegRow): string {
  const raw = row.TicketNumber ?? row.DocumentNumber;
  return raw === undefined || raw === null ? "" : String(raw).trim();
}

/** Resolve the customer id from either canonical or real-payload field names. */
function customerIdOf(row: DeletedWagerLegRow): string {
  const raw = row.customerID ?? row.CustomerID;
  return raw === undefined || raw === null ? "" : String(raw).trim();
}

/** Resolve the delete timestamp from either canonical or real-payload field names. */
function deleteDateTimeOf(row: DeletedWagerLegRow): string {
  const raw = row.DeleteDateTime ?? row.TranDateTime;
  return raw === undefined || raw === null ? "" : String(raw).trim();
}

/** Resolve the amount from either canonical or real-payload field names. */
function amountOf(row: DeletedWagerLegRow): string {
  const raw = row.AmountWagered ?? row.Amount ?? row.EnteredAmount;
  return raw === undefined || raw === null ? "" : String(raw).trim();
}

/** Resolve the login from either canonical or real-payload field names. */
function loginOf(row: DeletedWagerLegRow): string {
  const raw = row.Login ?? row.EnteredBy;
  return raw === undefined || raw === null ? "" : String(raw).trim();
}

/** Resolve the login id from either canonical or real-payload field names. */
function loginIdOf(row: DeletedWagerLegRow): string {
  const raw = row.LoginID ?? row.LastUpdateLoginID;
  return raw === undefined || raw === null ? "" : String(raw).trim();
}

/**
 * Dedupe legs into one target per (customerId, ticketNumber).
 * Prefers the row with the highest leg count seen for that ticket.
 */
export function dedupeDeletedWagerTargets(
  legs: readonly DeletedWagerLegRow[],
): DeletedWagerTicketTarget[] {
  const byKey = new Map<string, { legs: DeletedWagerLegRow[] }>();
  for (const leg of legs) {
    const customerId = trimCustomerId(customerIdOf(leg));
    const ticketNumber = ticketNumberOf(leg);
    if (!customerId || !ticketNumber) continue;
    const key = `${customerId}\t${ticketNumber}`;
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { legs: [] };
      byKey.set(key, bucket);
    }
    bucket.legs.push(leg);
  }

  const targets: DeletedWagerTicketTarget[] = [];
  for (const [, { legs: group }] of byKey) {
    const first = group[0]!;
    const ticketNumber = ticketNumberOf(first);
    const customerId = trimCustomerId(customerIdOf(first));
    targets.push({
      ticketNumber,
      customerId,
      login: trimLogin(loginOf(first)),
      deleteDateTime: deleteDateTimeOf(first),
      legCount: group.length,
      amountWagered: amountOf(first),
      wagerType: first.WagerType ?? "",
      loginId: loginIdOf(first),
      nameFirst: (first.NameFirst ?? "").trim(),
    });
  }

  targets.sort((a, b) => {
    const amt = Number(b.amountWagered) - Number(a.amountWagered);
    if (amt !== 0) return amt;
    return a.ticketNumber.localeCompare(b.ticketNumber);
  });
  return targets;
}

export function targetsFromEnvelope(
  envelope: DeletedWagerListEnvelope,
): DeletedWagerTicketTarget[] {
  return dedupeDeletedWagerTargets(envelope.INFO.LIST);
}
