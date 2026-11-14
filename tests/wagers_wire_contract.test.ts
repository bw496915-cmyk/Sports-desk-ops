import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createDevLiveWagersLoader } from "@sportsdesk-ops/backend";
import { parseShortDesc } from "../lib/live_wagers.ts";
import {
  inspectWagersWireContract,
  wagersWireContractPath,
} from "../lib/wagers_wire_contract.ts";

const REGISTRY = resolve(process.cwd(), "schema/wagers_field_contract.json");

/** One row that satisfies the registered wire shape. */
const goodRow = () => ({
  WagerType: "L",
  ShortDesc: "P.G1\r\nHockey - A vs B / Total / Over 1½ -150\r\n",
  VolumeAmount: 7500,
  VIP: "0",
});

const violationOf = (
  summary: Awaited<ReturnType<typeof inspectWagersWireContract>>,
  field: string,
) => summary.violations.find((v) => v.field === field);

describe("vendor wire contract at ingest", () => {
  test("the committed registry resolves and a conforming row is clean", async () => {
    const summary = await inspectWagersWireContract([goodRow()], REGISTRY);
    expect(summary.ok).toBe(true);
    expect(summary.rows).toBe(1);
    expect(summary.fields_checked).toEqual([
      "WagerType",
      "ShortDesc",
      "VolumeAmount",
      "VIP",
    ]);
    // Enum values are observed, not declared: the source travels with the result.
    expect(summary.enum_source).toBe("observed");
    expect(summary.violations).toEqual([]);
  });

  test("a type mismatch is a violation, counted across rows", async () => {
    const rows = [
      { ...goodRow(), VolumeAmount: "7500" as unknown as number },
      { ...goodRow(), VolumeAmount: null as unknown as number },
      goodRow(),
    ];
    const summary = await inspectWagersWireContract(rows, REGISTRY);
    expect(summary.ok).toBe(false);
    const typeHit = violationOf(summary, "VolumeAmount");
    expect(typeHit?.kind).toBe("type");
    expect(typeHit?.count).toBe(1);
    // null where nullable:false is the *other* axis, not the same bucket.
    expect(
      summary.violations.filter((v) => v.field === "VolumeAmount"),
    ).toHaveLength(2);
  });

  test("a null in a non-nullable field is reported as nullable", async () => {
    const summary = await inspectWagersWireContract(
      [{ ...goodRow(), VIP: null }],
      REGISTRY,
    );
    const hit = violationOf(summary, "VIP");
    expect(hit?.kind).toBe("nullable");
    expect(hit?.examples).toEqual(["null"]);
  });

  test("an unobserved enum value is a sample boundary, never a violation", async () => {
    const summary = await inspectWagersWireContract(
      [{ ...goodRow(), WagerType: "Z" }],
      REGISTRY,
    );
    expect(summary.ok).toBe(true);
    expect(violationOf(summary, "WagerType")).toBeUndefined();
  });

  test("sentinel-noise rows can be skipped, and the exclusion is counted", async () => {
    const rows = [
      goodRow(),
      {
        ...goodRow(),
        TicketWriter: "BLOCKED   ",
        WagerType: null,
        ShortDesc: null,
      },
    ];
    const withSentinel = await inspectWagersWireContract(rows, REGISTRY);
    expect(withSentinel.ok).toBe(false);
    expect(withSentinel.rows).toBe(2);
    expect(withSentinel.skipped_rows).toBe(0);

    const skipped = await inspectWagersWireContract(rows, REGISTRY, {
      skipRow: (row) =>
        String(row.TicketWriter ?? "")
          .trim()
          .toUpperCase() === "BLOCKED",
    });
    expect(skipped.ok).toBe(true);
    expect(skipped.rows).toBe(1);
    // The exclusion is visible, not silent.
    expect(skipped.skipped_rows).toBe(1);
  });

  test("a missing registry reports ok:false instead of silently passing", async () => {
    const summary = await inspectWagersWireContract(
      [goodRow()],
      resolve(process.cwd(), "schema/no-such-contract.json"),
    );
    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("unavailable");
    expect(summary.rows).toBe(1);
  });

  test("repeated payload builds reuse the scan for the same row array", async () => {
    const rows = [goodRow()];
    const first = await inspectWagersWireContract(rows, REGISTRY);
    const second = await inspectWagersWireContract(rows, REGISTRY);
    expect(second).toBe(first);

    // A new load (new array) is rescanned.
    expect(await inspectWagersWireContract([goodRow()], REGISTRY)).not.toBe(
      first,
    );
    // A predicate call is never memoized: the predicate is part of the call.
    expect(
      await inspectWagersWireContract(rows, REGISTRY, { skipRow: () => false }),
    ).not.toBe(first);
  });

  test("WAGERS_WIRE_CONTRACT_PATH points at the committed registry by default", () => {
    expect(
      wagersWireContractPath().endsWith("schema/wagers_field_contract.json"),
    ).toBe(true);
  });

  test("the live-wagers loader surfaces wire_contract for the raw corpus", async () => {
    const loader = createDevLiveWagersLoader({
      cwd: process.cwd(),
      candidatePaths: [
        resolve(process.cwd(), "tests/fixtures/live-wagers-LIST-100.json"),
      ],
      loadSharpDeps: async () => ({
        parseShortDesc,
        sharpCustomerIds: new Set<string>(),
      }),
      inspectRawRows: (rows) => inspectWagersWireContract(rows, REGISTRY),
    });
    const payload = (await loader.buildLiveWagersPayload()) as {
      wire_contract?: { ok: boolean; rows: number; violations: unknown[] };
    };
    expect(payload.wire_contract?.rows).toBe(100);
    expect(payload.wire_contract?.ok).toBe(true);
    expect(payload.wire_contract?.violations).toEqual([]);
  });
});
