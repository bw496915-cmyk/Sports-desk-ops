/**
 * @file lib/customer_book_normalize.ts
 * @description Repairs the internal inconsistencies in the demo customer book.
 *
 * Rules:
 *   - WIN  -> net_usd = +win_usd
 *   - LOSS -> net_usd = -risk_usd
 *   - VOID -> net_usd = 0
 *   - hold_pct = lifetime_net_usd / lifetime_volume_usd * 100 (2 dp)
 *
 * Unknown result codes are left untouched. Duplicate wager numbers are left untouched: the
 * fixture has no way to tell which row is authoritative.
 */

export interface NormalizeChange {
  readonly customerId: string;
  readonly kind: "TICKET_NET" | "HOLD_PCT";
  readonly before: number;
  readonly after: number;
  readonly label?: string;
}

export interface NormalizeResult<T> {
  readonly rows: T[];
  readonly changes: readonly NormalizeChange[];
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

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Returns new rows plus the list of changed fields. Input rows are not mutated. */
export function normalizeCustomerBook<T = unknown>(
  rows: readonly T[],
): NormalizeResult<T> {
  const changes: NormalizeChange[] = [];
  const out = rows.map((raw) => {
    const customer = asRecord(raw);
    if (customer === null) return raw;
    const customerId = String(customer.customer_id ?? "UNKNOWN");
    const next: Record<string, unknown> = { ...customer };

    const volume = num(customer.lifetime_volume_usd);
    const net = num(customer.lifetime_net_usd);
    const hold = num(customer.hold_pct);
    if (Number.isFinite(volume) && volume > 0 && Number.isFinite(net)) {
      const computed = round2((net / volume) * 100);
      if (!Number.isFinite(hold) || Math.abs(hold - computed) > 0.005) {
        changes.push({
          customerId,
          kind: "HOLD_PCT",
          before: hold,
          after: computed,
        });
        next.hold_pct = computed;
      }
    }

    const ticketRows = Array.isArray(customer.recent_tickets)
      ? customer.recent_tickets
      : null;
    if (ticketRows !== null) {
      next.recent_tickets = ticketRows.map((ticketRaw) => {
        const ticket = asRecord(ticketRaw);
        if (ticket === null) return ticketRaw;
        const result = String(ticket.result ?? "").toUpperCase();
        const risk = num(ticket.risk_usd);
        const win = num(ticket.win_usd);
        const current = num(ticket.net_usd);
        let target: number | null = null;
        if (result === "WIN" && Number.isFinite(win)) target = round2(win);
        else if (result === "LOSS" && Number.isFinite(risk))
          target = round2(-risk);
        else if (result === "VOID") target = 0;
        if (target === null || (Number.isFinite(current) && current === target))
          return ticket;
        changes.push({
          customerId,
          kind: "TICKET_NET",
          before: current,
          after: target,
          label: `${String(ticket.wager_number ?? "?")}/${result}`,
        });
        return { ...ticket, net_usd: target };
      });
    }

    return next as T;
  });
  return { rows: out, changes };
}
