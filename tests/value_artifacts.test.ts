import { describe, expect, test } from "bun:test";

interface GateArtifact {
  kept: number;
  permissiveCombos: number;
  exclusions: {
    UNRESOLVED_LEGS: number;
    CROSS_GAME: number;
    INELIGIBLE_LEG_TYPE: number;
  };
  includedCrossGame: number;
  distinctWallets: number;
}

interface ComboArtifact {
  schemaVersion: number;
  gates: Record<"permissive" | "all-legs-cfb" | "full-game", GateArtifact>;
  diagnostics: {
    unresolved: {
      combos: number;
      legs: number;
      distinctLegKeys: number;
      oneOffLegKeys: number;
      systemicLegKeys: number;
    };
  };
  dedupe: { collapsed: number; byId: number; byLegSet: number };
  chain: {
    edges: Array<{
      treatmentSize: number;
      referenceSize: number;
      leaks: number;
      vacuous: boolean;
    }>;
    leaks: number;
    vacuous: boolean;
  };
}

interface BridgeArtifact {
  schemaVersion: number;
  evidence: string;
  coverage: {
    customersInBook: number;
    linkedCustomers: number;
    wallets: number;
    observedWallets: number;
    invalidWallets: number;
    sharedWallets: number;
    linkYieldPct: number;
  };
  value: {
    customersWithPoly: number;
    customersWithPnl: number;
    bothUp: number;
    polyOnlyUp: number;
    deskOnlyUp: number;
    bothDown: number;
    flat: number;
    sharedWalletRows: number;
  };
  quarantined: number;
}

const combo = (await Bun.file(
  "docs/combo-uniqueness.json",
).json()) as ComboArtifact;
const bridge = (await Bun.file(
  "docs/cross-domain-bridge.json",
).json()) as BridgeArtifact;

describe("committed combo artifact invariants", () => {
  test("permissive = kept + exclusions for every gate", () => {
    for (const gate of Object.values(combo.gates)) {
      const dropped =
        gate.exclusions.UNRESOLVED_LEGS +
        gate.exclusions.CROSS_GAME +
        gate.exclusions.INELIGIBLE_LEG_TYPE;
      expect(gate.permissiveCombos).toBe(gate.kept + dropped);
    }
  });

  test("the gate chain is non-vacuous and leak-free", () => {
    expect(combo.chain.leaks).toBe(0);
    expect(combo.chain.vacuous).toBe(false);
    for (const edge of combo.chain.edges) {
      expect(edge.leaks).toBe(0);
      expect(edge.treatmentSize).toBeLessThanOrEqual(edge.referenceSize);
    }
    const [outer, inner] = combo.chain.edges;
    expect(outer?.treatmentSize).toBe(combo.gates["all-legs-cfb"].kept);
    expect(outer?.referenceSize).toBe(combo.gates.permissive.kept);
    expect(inner?.treatmentSize).toBe(combo.gates["full-game"].kept);
    expect(inner?.referenceSize).toBe(combo.gates["all-legs-cfb"].kept);
  });

  test("diagnostics and dedupe accounting add up", () => {
    const unresolved = combo.diagnostics.unresolved;
    expect(unresolved.oneOffLegKeys + unresolved.systemicLegKeys).toBe(
      unresolved.distinctLegKeys,
    );
    expect(unresolved.combos).toBe(
      combo.gates["all-legs-cfb"].exclusions.UNRESOLVED_LEGS,
    );
    expect(combo.dedupe.byId + combo.dedupe.byLegSet).toBe(
      combo.dedupe.collapsed,
    );
  });
});

describe("committed bridge artifact invariants", () => {
  test("coverage inequalities hold", () => {
    expect(bridge.coverage.observedWallets).toBeLessThanOrEqual(
      bridge.coverage.wallets,
    );
    expect(bridge.coverage.linkedCustomers).toBeLessThanOrEqual(
      bridge.coverage.customersInBook,
    );
    expect(bridge.value.customersWithPnl).toBeLessThanOrEqual(
      bridge.value.customersWithPoly,
    );
    expect(bridge.coverage.invalidWallets).toBe(bridge.quarantined);
    expect(bridge.coverage.linkYieldPct).toBeCloseTo(
      (bridge.coverage.linkedCustomers / bridge.coverage.customersInBook) * 100,
      2,
    );
  });

  test("verdict counts sum to the customers with a PnL figure", () => {
    const verdicts =
      bridge.value.bothUp +
      bridge.value.polyOnlyUp +
      bridge.value.deskOnlyUp +
      bridge.value.bothDown +
      bridge.value.flat;
    expect(verdicts).toBe(bridge.value.customersWithPnl);
  });

  test("shared-wallet rows match two customers per shared wallet", () => {
    expect(bridge.value.sharedWalletRows).toBe(
      bridge.coverage.sharedWallets * 2,
    );
  });
});
