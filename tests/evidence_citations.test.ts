import { describe, expect, test } from "bun:test";

interface LedgerEvidence {
  source?: string;
  note?: string;
}

interface LedgerOperation {
  tier: string;
  path: string;
  evidence?: LedgerEvidence[];
}

interface Ledger {
  tierRules: Record<string, string>;
  operations: LedgerOperation[];
}

const ledger = (await Bun.file("docs/evidence/ledger.json").json()) as Ledger;

function sources(): string[] {
  return ledger.operations.flatMap((op) =>
    (op.evidence ?? []).map((entry) => entry.source ?? ""),
  );
}

describe("evidence ledger citations", () => {
  test("does not cite the removed tracked-domains post-processor", () => {
    expect(JSON.stringify(ledger)).not.toContain("append_tracked_domains");
  });

  test("does not cite line numbers inside generated files", () => {
    const lineNumbered = sources().filter((source) =>
      /(?:docs\/openapi\.json|docs\/api-reference\.md):\d+/.test(source),
    );
    expect(lineNumbered).toEqual([]);
  });

  test("does not reference the removed OFFLINE_SIMULATION symbol", () => {
    expect(JSON.stringify(ledger)).not.toContain("OFFLINE_SIMULATION");
  });

  test("tier-A prose agrees with the tier-A rows", () => {
    const tierA = ledger.operations.filter((op) => op.tier === "A").length;
    expect(tierA).toBe(5);
    expect(ledger.tierRules.A).not.toContain(
      "Nothing in this release qualifies",
    );
    expect(ledger.tierRules.A).toContain("Five operations qualify");
  });
});
