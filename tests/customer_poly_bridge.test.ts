import { describe, expect, test } from "bun:test";
import {
  buildAttributionRegistry,
  buildCustomerPolyBridge,
  matchCustomerLegsAcrossVenues,
  seedCrossDomainScenario,
  validateWalletAddress,
  type AttributionInput,
  type CustomerBookRow,
  type PolyObservation,
} from "../lib/customer_poly_bridge.ts";
import {
  auditActivityPnl,
  type PolymarketActivity,
} from "../lib/polymarket_profile.ts";
import { createComboObservationsLegsStore } from "../lib/combo_observations_legs_store.ts";

const W1 = `0x${"1".repeat(40)}`;
const W2 = `0x${"2".repeat(40)}`;

function customer(
  overrides: Partial<CustomerBookRow> & { customerId: string },
): CustomerBookRow {
  return {
    agentId: "AGENT",
    contextType: "TEST",
    status: "Active",
    lifetimeVolumeUsd: 10_000,
    lifetimeNetUsd: 0,
    sports7dVolumeUsd: 1_000,
    sports7dNetUsd: 0,
    clvBps: 0,
    sharpScore: 50,
    churnHazard: 0.1,
    ...overrides,
  };
}

function observation(
  address: string,
  overrides: Partial<PolyObservation> = {},
): PolyObservation {
  return {
    address,
    name: null,
    pnlAllUsd: 2_000,
    pnl7dUsd: null,
    pnl30dUsd: null,
    cashflowPnlUsd: 1_500,
    pnlGapUsd: -500,
    pnlGapPct: -25,
    feeResidualUsd: 12,
    pnlComplete: true,
    tradeVolumeUsd: 50_000,
    positions: 10,
    openCount: 2,
    openValueUsd: 300,
    investedUsd: 1_000,
    winRate: 55,
    winRateEstimated: false,
    strategy: "Diversified",
    valueKind: "SIGNAL",
    comboSharePct: 80,
    topCategories: ["Sports"],
    pagesFetched: 3,
    activityTruncated: false,
    ...overrides,
  };
}

describe("wallet validation", () => {
  test("accepts 42-char hex and lowercases it", () => {
    expect(validateWalletAddress(`0x${"A".repeat(40)}`)).toEqual({
      valid: true,
      address: `0x${"a".repeat(40)}`,
    });
  });

  test("quarantines placeholders instead of querying them", () => {
    expect(validateWalletAddress("0x3af8392189d021cfa82")).toEqual({
      valid: false,
      address: "0x3af8392189d021cfa82",
      reason: "BAD_LENGTH",
    });
    const reasonOf = (raw: string): string | null => {
      const validation = validateWalletAddress(raw);
      return validation.valid ? null : validation.reason;
    };
    expect(reasonOf("not-a-wallet")).toBe("BAD_PREFIX");
    expect(reasonOf("")).toBe("EMPTY");
    expect(reasonOf(`0x${"z".repeat(40)}`)).toBe("NON_HEX");
  });
});

describe("attribution registry", () => {
  test("dedupes, uppercases customer ids and counts shared wallets", () => {
    const typed: AttributionInput[] = [
      {
        proxyWallet: W1,
        customerId: "c1",
        attributionType: "WHALE_CTF_BRIDGE",
        confidenceBps: 10_000,
      },
      {
        proxyWallet: W1.toUpperCase().replace("0X", "0x"),
        customerId: "C1",
        attributionType: "WHALE_CTF_BRIDGE",
      },
      { proxyWallet: W2, customerId: "c1", attributionType: "IP_CLUSTER" },
      { proxyWallet: W2, customerId: "c2", attributionType: "IP_CLUSTER" },
      { proxyWallet: "0xshort", customerId: "c3" },
    ];
    const registry = buildAttributionRegistry(typed, {
      includeEngineMap: false,
    });
    expect(registry.links).toHaveLength(3);
    expect(registry.quarantined).toHaveLength(1);
    expect(registry.stats.customers).toBe(2);
    expect(registry.stats.wallets).toBe(2);
    expect(registry.stats.multiWalletCustomers).toBe(1);
    expect(registry.stats.sharedWallets).toBe(1);
    expect(registry.byCustomer.get("C1")).toHaveLength(2);
    expect(registry.links[0]?.attributionType).toBe("WHALE_CTF_BRIDGE");
    expect(registry.links[0]?.confidenceBps).toBe(10_000);
  });

  test("default registry quarantines the 10 placeholder attributions", () => {
    const registry = buildAttributionRegistry();
    expect(registry.stats.invalid).toBe(10);
    expect(
      registry.links.every((link) => validateWalletAddress(link.wallet).valid),
    ).toBe(true);
  });
});

describe("cross-venue value", () => {
  const registry = buildAttributionRegistry(
    [
      { proxyWallet: W1, customerId: "C1", confidenceBps: 10_000 },
      { proxyWallet: W2, customerId: "C2", confidenceBps: 5_000 },
    ],
    { includeEngineMap: false },
  );

  test("uses the fee-aware basis when available and gross otherwise", () => {
    const customers = [
      // desk net negative = customer won 1,000 at the desk
      customer({ customerId: "C1", lifetimeNetUsd: -1_000 }),
      // desk net positive = customer lost 500 at the desk
      customer({ customerId: "C2", lifetimeNetUsd: 500 }),
      customer({ customerId: "C3" }),
    ];
    const observations = new Map<string, PolyObservation>([
      [W1, observation(W1)],
      [
        W2,
        observation(W2, {
          pnlAllUsd: 300,
          cashflowPnlUsd: null,
          pnlComplete: false,
        }),
      ],
    ]);
    const report = buildCustomerPolyBridge({
      customers,
      registry,
      observations,
    });

    const c1 = report.customers.find((row) => row.customerId === "C1");
    const c2 = report.customers.find((row) => row.customerId === "C2");
    expect(c1?.customerDeskPnlUsd).toBe(1_000);
    expect(c1?.pnlBasis).toBe("NET");
    expect(c1?.polyBasisPnlUsd).toBe(1_500);
    expect(c1?.polyAdvantageUsd).toBe(500);
    expect(c1?.verdict).toBe("BOTH_UP");
    expect(c1?.priorityUsd).toBe(500);

    expect(c2?.customerDeskPnlUsd).toBe(-500);
    expect(c2?.pnlBasis).toBe("GROSS");
    expect(c2?.polyBasisPnlUsd).toBe(300);
    expect(c2?.polyAdvantageUsd).toBe(800);
    expect(c2?.verdict).toBe("POLY_ONLY_UP");
    // 50% confidence on the link halves the ranking weight
    expect(c2?.priorityUsd).toBe(400);

    expect(report.coverage.customersInBook).toBe(3);
    expect(report.coverage.linkedCustomers).toBe(2);
    expect(report.value.polyOnlyUp).toBe(1);
    expect(report.value.netCoveragePct).toBe(50);
    expect(report.evidence).toBe("LIVE");

    // One linked wallet without an observation downgrades the tier to MIXED.
    const partial = buildCustomerPolyBridge({
      customers,
      registry,
      observations: new Map([[W1, observation(W1)]]),
    });
    expect(partial.evidence).toBe("MIXED");
    expect(partial.coverage.observedWallets).toBe(1);
  });

  test("counts a shared wallet once and excludes it from advantage totals", () => {
    const shared = buildAttributionRegistry(
      [
        { proxyWallet: W1, customerId: "C1", confidenceBps: 10_000 },
        { proxyWallet: W1, customerId: "C2", confidenceBps: 5_000 },
      ],
      { includeEngineMap: false },
    );
    const report = buildCustomerPolyBridge({
      customers: [
        customer({ customerId: "C1", lifetimeNetUsd: -1_000 }),
        customer({ customerId: "C2", lifetimeNetUsd: 500 }),
      ],
      registry: shared,
      observations: new Map([[W1, observation(W1)]]),
    });
    expect(report.value.sharedWalletRows).toBe(2);
    expect(report.value.polyPnlUsd).toBe(1_500);
    expect(report.value.polyGrossPnlUsd).toBe(2_000);
    expect(report.value.polyAdvantageUsd).toBe(0);
    expect(report.value.priorityUsd).toBe(0);
    // Per-row math is still reported for audit.
    expect(
      report.customers.find((row) => row.customerId === "C1")?.polyAdvantageUsd,
    ).toBe(500);
    expect(
      report.customers.find((row) => row.customerId === "C2")?.polyAdvantageUsd,
    ).toBe(2_000);
  });

  test("counts attribution links, not wallets, and keeps the legacy alias", () => {
    const links = buildAttributionRegistry(
      [
        {
          proxyWallet: W1,
          customerId: "C1",
          attributionType: "WHALE_CTF_BRIDGE",
        },
        { proxyWallet: W2, customerId: "C1", attributionType: "IP_CLUSTER" },
        { proxyWallet: W2, customerId: "C2", attributionType: "IP_CLUSTER" },
      ],
      { includeEngineMap: false },
    );
    const report = buildCustomerPolyBridge({
      customers: [
        customer({ customerId: "C1" }),
        customer({ customerId: "C2" }),
      ],
      registry: links,
    });
    const linkSum = Object.values(report.coverage.attributionLinks).reduce(
      (total, count) => total + count,
      0,
    );

    // Two wallets, three link rows: `wallets` undercounts what attributionTypes reports.
    expect(report.coverage.wallets).toBe(2);
    expect(linkSum).toBe(3);
    expect(linkSum).toBe(report.coverage.attributionLinkRows);
    expect(report.coverage.attributionLinkRows).toBe(links.links.length);
    expect(report.coverage.attributionLinkRows).toBeGreaterThan(
      report.coverage.wallets,
    );
    expect(report.coverage.attributionLinks).toEqual({
      WHALE_CTF_BRIDGE: 1,
      IP_CLUSTER: 2,
    });
    // The legacy field still resolves to the same link counts for existing readers.
    expect(report.coverage.attributionTypes).toEqual(
      report.coverage.attributionLinks,
    );
  });

  test("reports fixture evidence when nothing was fetched", () => {
    const report = buildCustomerPolyBridge({
      customers: [customer({ customerId: "C1" })],
      registry,
    });
    expect(report.evidence).toBe("FIXTURE");
    expect(report.value.customersWithPoly).toBe(0);
    expect(report.customers[0]?.verdict).toBeNull();
  });
});

describe("fee-aware activity audit", () => {
  const rows: PolymarketActivity[] = [
    {
      type: "TRADE",
      slug: "a",
      usdcSize: 100.1,
      side: "BUY",
      size: 200,
      price: 0.5,
      timestamp: 1,
      title: "A",
      outcome: "Yes",
    },
    {
      type: "SELL",
      slug: "a",
      usdcSize: 150,
      side: "SELL",
      timestamp: 2,
      title: "A",
      outcome: "Yes",
    },
    {
      type: "REDEEM",
      slug: "b",
      usdcSize: 25,
      side: "",
      timestamp: 3,
      title: "B",
      outcome: "Yes",
    },
    {
      type: "SPLIT",
      slug: "c",
      usdcSize: 10,
      side: "",
      timestamp: 4,
      title: "C",
      outcome: "Yes",
    },
  ];

  test("reconstructs cashflow, gap and the fee residual", () => {
    const audit = auditActivityPnl(rows, 30, { lbApiPnlUsd: 120 });
    // in 150 + 25, out 100.1 + 10, open 30 → 94.9
    expect(audit.grossInUsd).toBe(175);
    expect(audit.grossOutUsd).toBe(110.1);
    expect(audit.cashflowPnlUsd).toBe(94.9);
    expect(audit.gapUsd).toBeCloseTo(-25.1, 6);
    expect(audit.gapPct).toBeCloseTo(-20.92, 2);
    expect(audit.feeResidualUsd).toBeCloseTo(0.1, 6);
    expect(audit.feeRows).toBe(1);
    expect(audit.complete).toBe(true);
  });

  test("withholds cashflow when pagination was truncated", () => {
    const audit = auditActivityPnl(rows, 30, {
      lbApiPnlUsd: 120,
      activityTruncated: true,
    });
    expect(audit.complete).toBe(false);
    expect(audit.cashflowPnlUsd).toBeNull();
    expect(audit.gapUsd).toBeNull();
    expect(audit.reason).toContain("ACTIVITY_TRUNCATED");
    // gross flows are still reported
    expect(audit.grossInUsd).toBe(175);
  });
});

describe("leg-level cross-domain matching", () => {
  test("matches attributed legs, keeps opposite sides, and honours the customer filter", () => {
    const store = createComboObservationsLegsStore();
    const registry = buildAttributionRegistry();
    seedCrossDomainScenario(store, registry);

    const report = matchCustomerLegsAcrossVenues(store.db, {
      databasePath: ":memory:",
      maxLineDeltaHundredths: 100,
    });
    expect(report.matchedLegs).toBe(5);
    expect(report.mirrorLegs).toBe(4);
    expect(report.oppositeLegs).toBe(1);
    expect(report.layoffRiskLegs).toBe(3);
    expect(report.customers.map((row) => row.customerId).sort()).toEqual([
      "AT10359",
      "BGD101",
      "DA4401",
      "GP300",
      "MJ102",
    ]);
    const da = report.customers.find((row) => row.customerId === "DA4401");
    expect(da?.opposite).toBe(1);
    expect(da?.mirror).toBe(0);

    const filtered = matchCustomerLegsAcrossVenues(store.db, {
      customerId: "gp300",
    });
    expect(filtered.matchedLegs).toBe(1);
    expect(filtered.customers[0]?.customerId).toBe("GP300");
    expect(filtered.layoffRiskLegs).toBe(1);

    store.db.close();
  });

  test("excludes pairs whose line delta exceeds the window", () => {
    const store = createComboObservationsLegsStore();
    seedCrossDomainScenario(store, buildAttributionRegistry());
    const report = matchCustomerLegsAcrossVenues(store.db, {
      maxLineDeltaHundredths: 0,
    });
    expect(report.matchedLegs).toBe(0);
    store.db.close();
  });
});
