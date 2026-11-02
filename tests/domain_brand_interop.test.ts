import { describe, expect, test } from "bun:test";
import {
  assertCents as assertDesignCents,
  isCents as isDesignCents,
  parseAsCents as designCents,
  type Cents as DesignCents,
} from "../design/domain-branded-types.ts";
import {
  parseAsCents as serviceCents,
  type Cents as ServiceCents,
} from "../services/simulate_bettor_churn_suite.ts";
import type { Cents as PassCents } from "../services/agent_onepass_plugin.ts";

/**
 * One brand engine, three modules.
 *
 * `design/domain-branded-types.ts` declared `const __brand = Symbol("brand")` and the two
 * services declared their own `declare const __brand: unique symbol`. Three nominal identities
 * for one concept: `Cents` from any one of them was not assignable to `Cents` from another, so
 * every cross-module call needed a cast — which is the thing the brand exists to prevent.
 *
 * The assignments below are the guard. They contain no casts, and `bun run typecheck` compiles
 * this file, so re-declaring `__brand` in any of the three modules fails the build rather than
 * failing silently at a call site months later.
 */

describe("brand engine is shared across modules", () => {
  test("a Cents branded in one module is a Cents in the others", () => {
    const fromDesign: DesignCents = designCents(1234);
    const asService: ServiceCents = fromDesign;
    const asPass: PassCents = asService;
    const backToDesign: DesignCents = asPass;

    // expect() is generic over the received value, so a branded value needs a plain comparator.
    expect(Number(backToDesign)).toBe(1234);
    // Runtime is a bare number, so the identity is compile-time only — but the guards from a
    // different module must still accept it.
    expect(isDesignCents(asService)).toBe(true);
    expect(isDesignCents(serviceCents(99))).toBe(true);
    assertDesignCents(asPass);
  });

  test("the brand still rejects an unbranded primitive", () => {
    // @ts-expect-error a bare number is not Cents: the brand has not collapsed into `number`
    const notBranded: DesignCents = 5;
    expect(typeof notBranded).toBe("number");
  });
});
