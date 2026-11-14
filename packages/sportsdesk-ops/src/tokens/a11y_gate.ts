import { deltaE2000Hex, wcagContrastRatio } from "./perceptual.ts";
import type { TokensV13 } from "./tokens_v13.ts";

export type A11yGateCode =
  "ERR_A11Y_CONTRAST_BELOW_FLOOR" | "ERR_A11Y_FOCUS_TRAP_LOOP";

export type A11yViolation = {
  readonly code: A11yGateCode;
  readonly check: string;
  readonly detail: string;
};

export class A11yGateError extends Error {
  override readonly name = "A11yGateError";
  readonly code: A11yGateCode;
  constructor(readonly violations: readonly A11yViolation[]) {
    const first = violations[0];
    super(
      `${first?.code ?? "ERR_A11Y_CONTRAST_BELOW_FLOOR"}: ${violations.length} violation(s)\n` +
        violations
          .map((entry) => `  ${entry.code} ${entry.check}: ${entry.detail}`)
          .join("\n"),
    );
    this.code = first?.code ?? "ERR_A11Y_CONTRAST_BELOW_FLOOR";
  }
}

/** The spec's floors; tokens.toml [gates] may tighten them but never loosen them. */
export const SPEC_FLOORS_MILLI = {
  wcagBodyTextMinMilli: 4500,
  wcagAaaMutedMinMilli: 7000,
  wcagInteractiveMinMilli: 3000,
  crossStateDeltaE00MinMilli: 7000,
  slaFreshStaleDeltaE00MinMilli: 40000,
} as const;

export const AAA_MUTED_PAIR = {
  foreground: "#94a3b8",
  background: "#0b1120",
} as const;
export const UI_STATE_UNION_EXPECTED = 0x03ff;

const BADGE_FAMILIES = ["live", "capture", "stale", "fixture"] as const;

export type ContrastRow = {
  readonly check: string;
  readonly foreground: string;
  readonly background: string;
  readonly ratio: number;
  readonly floorMilli: number;
};

export type DeltaRow = {
  readonly check: string;
  readonly first: string;
  readonly second: string;
  readonly deltaE00: number;
  readonly floorMilli: number;
};

export type A11yReport = {
  readonly contrast: readonly ContrastRow[];
  readonly deltas: readonly DeltaRow[];
  readonly violations: readonly A11yViolation[];
};

function meetsMilli(value: number, floorMilli: number): boolean {
  return Math.round(value * 1000) >= floorMilli;
}

export function auditA11y(ssot: TokensV13): A11yReport {
  const contrast: ContrastRow[] = [];
  const deltas: DeltaRow[] = [];
  const violations: A11yViolation[] = [];
  const gates = ssot.gates;

  for (const [field, floor] of Object.entries(SPEC_FLOORS_MILLI)) {
    const configured = gates[field as keyof typeof SPEC_FLOORS_MILLI];
    if (configured < floor) {
      violations.push({
        code: "ERR_A11Y_CONTRAST_BELOW_FLOOR",
        check: `gates.${field}`,
        detail: `${configured} loosens the spec floor ${floor}`,
      });
    }
  }

  const surfaces = [
    ...ssot.surfaces.map((slot) => slot.hex),
    ...ssot.ui
      .filter((slot) => slot.role === "surface")
      .map((slot) => slot.hex),
  ];
  const addContrast = (
    check: string,
    foreground: string,
    background: string,
    floorMilli: number,
  ): void => {
    const ratio = wcagContrastRatio(foreground, background);
    contrast.push({ check, foreground, background, ratio, floorMilli });
    if (!meetsMilli(ratio, floorMilli)) {
      violations.push({
        code: "ERR_A11Y_CONTRAST_BELOW_FLOOR",
        check,
        detail: `${foreground} on ${background} is ${ratio.toFixed(3)}:1 < ${floorMilli / 1000}:1`,
      });
    }
  };

  for (const text of ssot.ui.filter((slot) => slot.role === "text")) {
    for (const surface of surfaces) {
      addContrast(
        `body-text ${text.tokenName}`,
        text.hex,
        surface,
        gates.wcagBodyTextMinMilli,
      );
    }
  }
  addContrast(
    "aaa-muted",
    AAA_MUTED_PAIR.foreground,
    AAA_MUTED_PAIR.background,
    gates.wcagAaaMutedMinMilli,
  );

  const interactive = ssot.ui.filter(
    (slot) => slot.key === "border_strong" || slot.key === "focus_ring",
  );
  for (const border of interactive) {
    for (const surface of surfaces) {
      addContrast(
        `interactive ${border.tokenName}`,
        border.hex,
        surface,
        gates.wcagInteractiveMinMilli,
      );
    }
  }
  const card = ssot.ui.find((slot) => slot.key === "surface_card");
  for (const family of BADGE_FAMILIES) {
    const border = ssot.tokenMap.get(`sd-provenance-${family}-border`);
    const background = ssot.tokenMap.get(`sd-provenance-${family}-bg`);
    if (
      border === undefined ||
      background === undefined ||
      card === undefined
    ) {
      violations.push({
        code: "ERR_A11Y_CONTRAST_BELOW_FLOOR",
        check: `badge ${family}`,
        detail: "badge tokens missing",
      });
      continue;
    }
    addContrast(
      `badge ${family} border/bg`,
      border,
      background,
      gates.wcagInteractiveMinMilli,
    );
    addContrast(
      `badge ${family} border/card`,
      border,
      card.hex,
      gates.wcagInteractiveMinMilli,
    );
  }
  for (const state of ssot.sla) {
    for (const surface of ssot.surfaces
      .map((slot) => slot.hex)
      .concat(card === undefined ? [] : [card.hex])) {
      addContrast(
        `sla ${state.key}`,
        state.hex,
        surface,
        gates.wcagInteractiveMinMilli,
      );
    }
  }

  const addDelta = (
    check: string,
    first: string,
    second: string,
    floorMilli: number,
  ): void => {
    const deltaE00 = deltaE2000Hex(first, second);
    deltas.push({ check, first, second, deltaE00, floorMilli });
    if (!meetsMilli(deltaE00, floorMilli)) {
      violations.push({
        code: "ERR_A11Y_CONTRAST_BELOW_FLOOR",
        check,
        detail: `dE00(${first}, ${second}) = ${deltaE00.toFixed(3)} < ${floorMilli / 1000}`,
      });
    }
  };
  const stateChain = ["surface_card", "surface_hover", "surface_selected"].map(
    (key) => ssot.ui.find((slot) => slot.key === key),
  );
  for (const [chainIndex, first] of stateChain.entries()) {
    for (const second of stateChain.slice(chainIndex + 1)) {
      if (first === undefined || second === undefined) continue;
      addDelta(
        `cross-state ${first.key}->${second.key}`,
        first.hex,
        second.hex,
        gates.crossStateDeltaE00MinMilli,
      );
    }
  }
  for (const [stateIndex, first] of ssot.sla.entries()) {
    for (const second of ssot.sla.slice(stateIndex + 1)) {
      const isFreshStale = first.key === "fresh" && second.key === "stale";
      addDelta(
        `sla ${first.key}->${second.key}`,
        first.hex,
        second.hex,
        isFreshStale
          ? gates.slaFreshStaleDeltaE00MinMilli
          : gates.crossStateDeltaE00MinMilli,
      );
    }
  }

  const union = ssot.uiStateFlags.reduce(
    (mask, flag) => (mask | (1 << flag.bit)) >>> 0,
    0,
  );
  const keyed = ssot.keymap.reduce((mask, slot) => {
    const flag = ssot.uiStateFlags.find(
      (entry) => entry.name === slot.uiStateFlag,
    );
    return flag === undefined ? mask : (mask | (1 << flag.bit)) >>> 0;
  }, 0);
  if (union !== UI_STATE_UNION_EXPECTED || keyed !== UI_STATE_UNION_EXPECTED) {
    violations.push({
      code: "ERR_A11Y_FOCUS_TRAP_LOOP",
      check: "unionMask32",
      detail: `ui_state union 0x${union.toString(16)} / keymap union 0x${keyed.toString(16)}, expected 0x3ff`,
    });
  }
  return { contrast, deltas, violations };
}

export function assertA11yGates(ssot: TokensV13): A11yReport {
  const report = auditA11y(ssot);
  if (report.violations.length > 0) throw new A11yGateError(report.violations);
  return report;
}
