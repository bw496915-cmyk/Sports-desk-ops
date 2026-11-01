import { describe, expect, test } from "bun:test";

import {
  buildBatchPendingDeleteExpression,
  buildPendingDeleteBodies,
  countPendingInResponseText,
  parsePendingDeleteBatchRows,
  redactPendingDeletePreview,
} from "./f402_pending_delete_batch.ts";

describe("pending delete batch", () => {
  test("builds form bodies per ticket", () => {
    const items = buildPendingDeleteBodies("AGENT1", "PH1009", [
      "1073143417",
      "1073143418",
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]?.body).toContain("customerID=PH1009");
    expect(items[0]?.body).toContain("ticketNumber=1073143417");
    expect(items[1]?.body).toContain("ticketNumber=1073143418");
  });

  test("batch expression includes all tickets", () => {
    const items = buildPendingDeleteBodies("AGENT1", "TACO217", ["1"]);
    const expr = buildBatchPendingDeleteExpression(
      "https://fantasy402.com/cloud/api/Report/PendingDelete",
      items,
    );
    expect(expr).toContain("ticketNumber=1");
    expect(expr).toContain("for (const item of items)");
    expect(expr).toContain('accept: "*/*"');
  });

  test("counts Pending from full JSON text", () => {
    const text = JSON.stringify({
      Pending: [{ TicketNumber: "1" }, { TicketNumber: "2" }],
    });
    expect(countPendingInResponseText(text)).toBe(2);
    expect(countPendingInResponseText('{"Pending":[]}')).toBe(0);
  });

  test("parses evaluate rows and redacts passwords in preview", () => {
    const raw = [
      {
        ticketNumber: "99",
        status: 200,
        bytes: 10,
        bodyText: '{"Pending":[{"Password":"secret"}]}',
        preview: '{"Pending":[{"Password":"secret"}]}',
      },
    ];
    const rows = parsePendingDeleteBatchRows(raw);
    expect(rows[0]?.ticketNumber).toBe("99");
    expect(
      redactPendingDeletePreview('{"Password":"secret"}'),
    ).toContain("<redacted>");
  });
});
