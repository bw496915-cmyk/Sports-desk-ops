/**
 * @file lib/customer_book_audit.ts
 * @description Data-quality audit for the customer book (`enriched_customers_full.json`).
 *
 * The bundled book is a demo fixture. Its ticket `result` and `net_usd` fields disagree on
 * ~31% of rows, and `hold_pct` never equals `net/volume` (it carries sentinels like -100).
 * Consumers must not trust those fields; this audit makes the damage visible instead of
 * letting it leak into reports.
 */

export type CustomerBookIssueKind =
  | "RESULT_NET_MISMATCH"
  | "UNKNOWN_RESULT"
  | "HOLD_PCT_MISMATCH"
  | "NON_FINITE_AMOUNT"
  | "DUPLICATE_WAGER_NUMBER";

export type CustomerBookSeverity = "error" | "warning";

export interface CustomerBookIssue {
  readonly customerId: string;
  readonly kind: CustomerBookIssueKind;
  /** `warning` issues are suspicious but not provably wrong (e.g. a per-agent wager sequence). */
  readonly severity: CustomerBookSeverity;
  readonly detail: string;
}

export interface CustomerBookAudit {
  readonly customers: number;
  readonly tickets: number;
  readonly issues: readonly CustomerBookIssue[];
  readonly byKind: Readonly<Record<CustomerBookIssueKind, number>>;
  readonly errors: number;
  readonly warnings: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Audits normalized book rows. Pure: no I/O, no clock. */
export function auditCustomerBook(rows: readonly unknown[]): CustomerBookAudit {
  const issues: CustomerBookIssue[] = [];
  const byKind: Record<CustomerBookIssueKind, number> = {
    RESULT_NET_MISMATCH: 0,
    UNKNOWN_RESULT: 0,
    HOLD_PCT_MISMATCH: 0,
    NON_FINITE_AMOUNT: 0,
    DUPLICATE_WAGER_NUMBER: 0,
  };
  const push = (
    customerId: string,
    kind: CustomerBookIssueKind,
    detail: string,
    severity: CustomerBookSeverity = "error",
  ): void => {
    byKind[kind] += 1;
    issues.push({ customerId, kind, severity, detail });
  };

  const seenWagers = new Map<number, string>();
  let tickets = 0;

  for (const raw of rows) {
    const customer = asRecord(raw);
    if (customer === null) continue;
    const customerId = text(customer.customer_id) || "UNKNOWN";

    const volume = num(customer.lifetime_volume_usd);
    const net = num(customer.lifetime_net_usd);
    const hold = num(customer.hold_pct);
    if (
      !Number.isFinite(volume) ||
      !Number.isFinite(net) ||
      !Number.isFinite(hold)
    ) {
      push(
        customerId,
        "NON_FINITE_AMOUNT",
        "lifetime volume/net/hold is not finite",
      );
    } else if (volume > 0) {
      const implied = (net / volume) * 100;
      if (Math.abs(implied - hold) > 0.05) {
        push(
          customerId,
          "HOLD_PCT_MISMATCH",
          `hold_pct ${hold} != net/volume ${implied.toFixed(2)}`,
        );
      }
    }

    const ticketRows = Array.isArray(customer.recent_tickets)
      ? customer.recent_tickets
      : [];
    for (const ticketRaw of ticketRows) {
      const ticket = asRecord(ticketRaw);
      if (ticket === null) continue;
      tickets += 1;
      const result = text(ticket.result).toUpperCase();
      const risk = num(ticket.risk_usd);
      const win = num(ticket.win_usd);
      const ticketNet = num(ticket.net_usd);
      const label = `${customerId}/${text(ticket.wager_number)}`;

      if (
        !Number.isFinite(risk) ||
        !Number.isFinite(win) ||
        !Number.isFinite(ticketNet)
      ) {
        push(label, "NON_FINITE_AMOUNT", "ticket risk/win/net is not finite");
      }

      if (result === "WIN") {
        if (ticketNet <= 0)
          push(label, "RESULT_NET_MISMATCH", `WIN with net_usd ${ticketNet}`);
      } else if (result === "LOSS") {
        if (ticketNet >= 0)
          push(label, "RESULT_NET_MISMATCH", `LOSS with net_usd ${ticketNet}`);
      } else if (result === "VOID") {
        if (ticketNet !== 0)
          push(label, "RESULT_NET_MISMATCH", `VOID with net_usd ${ticketNet}`);
      } else {
        push(
          label,
          "UNKNOWN_RESULT",
          `result "${result || "(empty)"}" is not WIN|LOSS|VOID`,
        );
      }

      const wager = num(ticket.wager_number);
      if (Number.isFinite(wager)) {
        const previous = seenWagers.get(wager);
        const signature = `${customerId}/${text(ticket.selection)}`;
        if (previous !== undefined && previous !== signature) {
          push(
            label,
            "DUPLICATE_WAGER_NUMBER",
            `wager ${wager} also seen as ${previous}`,
            "warning",
          );
        } else {
          seenWagers.set(wager, signature);
        }
      }
    }
  }

  const errors = issues.filter((issue) => issue.severity === "error").length;
  return {
    customers: rows.length,
    tickets,
    issues,
    byKind,
    errors,
    warnings: issues.length - errors,
  };
}
