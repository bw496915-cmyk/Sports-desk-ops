import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { SIGNAL_CHANNEL_POLICY_SPECIFICATION_TABLE } from "../../../lib/bridge_and_channel_router.ts";
import { packChannelHandle32 as libPackChannelHandle32 } from "../../../lib/nsh_frame_schema.ts";
import { DASHBOARD_TAB_IDS } from "../../ui/src/types.ts";
import {
  CHANNEL_CODES,
  CHANNEL_META_PACKED32_COL,
  GATES_MILLI,
  KEYMAP_SLOTS,
  packChannelHandle32,
  TAU_STAR_BASIS_POINTS,
  TOKENS_SCHEMA_VERSION,
  UI_STATE_UNION_MASK32,
} from "../src/generated/domain-branded-types.ts";
import {
  A11yGateError,
  AAA_MUTED_PAIR,
  assertA11yGates,
  auditA11y,
  SPEC_FLOORS_MILLI,
} from "../src/tokens/a11y_gate.ts";
import {
  deltaE2000,
  deltaE2000Hex,
  labOf,
  wcagContrastRatio,
} from "../src/tokens/perceptual.ts";
import {
  findFloatLiterals,
  parseTokensV13,
  TokensContractError,
} from "../src/tokens/tokens_v13.ts";

const tokensPath = resolve(import.meta.dir, "../../../design/tokens.toml");
const tomlText = await Bun.file(tokensPath).text();
const ssot = parseTokensV13(tomlText);

function mutate(search: string, replacement: string): string {
  if (!tomlText.includes(search))
    throw new Error(`fixture anchor missing: ${search}`);
  return tomlText.replace(search, replacement);
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  return "no error";
}

describe('Bun.color(hex, "lab") and CIEDE2000', () => {
  test("Bun 1.4.4 returns a CSS lab() string with L as a percentage", () => {
    expect(Bun.color("#ffffff", "lab")).toMatch(/^lab\(100% /);
    expect(labOf("#000000")).toEqual({
      lightness: 0,
      greenRed: 0,
      blueYellow: 0,
    });
  });

  test("dE00 matches the Sharma, Wu & Dalal reference pairs", () => {
    const pairs: [number, number, number, number, number, number, number][] = [
      [50, 2.6772, -79.7751, 50, 0, -82.7485, 2.0425],
      [50, 2.49, -0.001, 50, -2.49, 0.0009, 7.1792],
      [50, 2.5, 0, 73, 25, -18, 27.1492],
      [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
      [2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
    ];
    for (const [l1, a1, b1, l2, a2, b2, expected] of pairs) {
      const first = { lightness: l1, greenRed: a1, blueYellow: b1 };
      const second = { lightness: l2, greenRed: a2, blueYellow: b2 };
      expect(deltaE2000(first, second)).toBeCloseTo(expected, 4);
      expect(deltaE2000(second, first)).toBeCloseTo(expected, 4);
    }
    expect(deltaE2000Hex("#38bdf8", "#38bdf8")).toBe(0);
  });

  test("WCAG 2.1 contrast bounds", () => {
    expect(wcagContrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 10);
    expect(wcagContrastRatio("#777777", "#777777")).toBe(1);
  });
});

describe("tokens.toml v1.3.0 contract", () => {
  test("schema version, zero floats, integer gates at or above the spec floors", () => {
    expect(ssot.version).toBe("1.3.0");
    expect(TOKENS_SCHEMA_VERSION).toBe("1.3.0");
    expect(findFloatLiterals(tomlText)).toEqual([]);
    expect(ssot.tauStarBasisPoints).toBe(6800);
    expect(Number(TAU_STAR_BASIS_POINTS)).toBe(6800);
    for (const [field, floor] of Object.entries(SPEC_FLOORS_MILLI)) {
      const configured = GATES_MILLI[field as keyof typeof SPEC_FLOORS_MILLI];
      expect(Number.isSafeInteger(configured)).toBe(true);
      expect(configured).toBeGreaterThanOrEqual(floor);
    }
  });

  test("a float literal anywhere in a value is refused", () => {
    expect(
      codeOf(() =>
        parseTokensV13(
          mutate("tau_star_basis_points = 6800", "tau_star = 0.68"),
        ),
      ),
    ).toBe("ERR_TOKENS_FLOAT_FORBIDDEN");
    expect(
      findFloatLiterals('a = 1e3\nb = "0.5"\nc = 2 # 0.5\nd = [1, 2.5]'),
    ).toEqual(["line 1: a = 1e3", "line 4: d = [1, 2.5]"]);
  });

  test("[surfaces.*]/[ui.*]/[sla.*] hex is byte-identical to [tokens], legacy aliases kept", () => {
    for (const legacy of [
      "sd-surface-panel",
      "sd-border-default",
      "sd-theme-emerald",
    ]) {
      expect(ssot.tokenMap.has(legacy)).toBe(true);
    }
    expect(
      codeOf(() =>
        parseTokensV13(
          mutate(
            '"sd-surface-hover" = "#192849"',
            '"sd-surface-hover" = "#192848"',
          ),
        ),
      ),
    ).toBe("ERR_TOKENS_HEX_PARITY");
    expect(
      codeOf(() =>
        parseTokensV13(mutate('"sd-border-default" = "#1e293b"\n', "")),
      ),
    ).toBe("ERR_TOKENS_HEX_PARITY");
  });

  test("ingestion rows carry channel_id, sla_tens_of_ms, bridges, and wire_aliases that agree with the router", () => {
    expect([...CHANNEL_META_PACKED32_COL].length).toBe(ssot.ingestion.length);
    for (const [rowIndex, channel] of ssot.ingestion.entries()) {
      const policy =
        SIGNAL_CHANNEL_POLICY_SPECIFICATION_TABLE[
          channel.channelCode as keyof typeof SIGNAL_CHANNEL_POLICY_SPECIFICATION_TABLE
        ];
      expect(policy.channelOrdinal5).toBe(channel.channelId);
      expect(Number(policy.executionSlaDurationMs)).toBe(
        channel.slaTensOfMs * 10,
      );
      expect((Number(policy.permittedBridgeBitMask32) >>> 0) & 0xf).toBe(
        channel.bridgeMask4,
      );
      const word = CHANNEL_META_PACKED32_COL[rowIndex] ?? -1;
      expect(word >>> 28).toBe(channel.channelId);
      expect((word >>> 20) & 0xff).toBe(channel.slaTensOfMs);
      expect((word >>> 16) & 0xf).toBe(channel.bridgeMask4);
      expect(CHANNEL_CODES[rowIndex]).toBe(channel.channelCode);
    }
    expect(ssot.bridges.map((bridge) => bridge.bridgeId)).toEqual([0, 1, 2, 3]);
    expect(
      codeOf(() => parseTokensV13(mutate("channel_id = 8", "channel_id = 16"))),
    ).toBe("ERR_TOKENS_SHAPE");
    expect(
      codeOf(() =>
        parseTokensV13(mutate("sla_tens_of_ms = 150", "sla_tens_of_ms = 15")),
      ),
    ).toBe("ERR_TOKENS_INGESTION_INCOMPLETE");
    expect(
      codeOf(() =>
        parseTokensV13(
          mutate(
            'wire_aliases = ["GATEWAY"]',
            'wire_aliases = ["GATEWAY", "ALERT"]',
          ),
        ),
      ),
    ).toBe("ERR_TOKENS_INGESTION_INCOMPLETE");
    expect(
      codeOf(() => parseTokensV13(mutate("bridge_id = 3", "bridge_id = 2"))),
    ).toBe("ERR_TOKENS_BRIDGES_INCOMPLETE");
  });

  test("generated packChannelHandle32 is bit-identical to lib/nsh_frame_schema.ts", () => {
    const samples: [number, number, number][] = [
      [0, 0, 0],
      [15, 255, 0xfffff],
      [4, 150, 12345],
      [8, 200, 1],
    ];
    for (const [channelId4, slaTens, rowIndex20] of samples) {
      expect(Number(packChannelHandle32(channelId4, slaTens, rowIndex20))).toBe(
        Number(libPackChannelHandle32(channelId4, slaTens, rowIndex20)),
      );
    }
    expect(() => packChannelHandle32(16, 0, 0)).toThrow(RangeError);
  });

  test("BitSet32 masks are unsigned, unique, and capped at bit 30", () => {
    for (const flag of [...ssot.betLegFlags, ...ssot.uiStateFlags]) {
      expect(flag.bit).toBeGreaterThanOrEqual(0);
      expect(flag.bit).toBeLessThanOrEqual(30);
    }
    expect(codeOf(() => parseTokensV13(mutate("live = 5", "live = 31")))).toBe(
      "ERR_TOKENS_BITSET_RANGE",
    );
    expect(codeOf(() => parseTokensV13(mutate("live = 5", "live = 4")))).toBe(
      "ERR_TOKENS_BITSET_RANGE",
    );
  });

  test("unionMask32 === 0x03ff", () => {
    expect(Number(UI_STATE_UNION_MASK32)).toBe(0x03ff);
    const keyed = KEYMAP_SLOTS.reduce(
      (mask, slot) => (mask | Number(slot.uiStateMask32)) >>> 0,
      0,
    );
    expect(keyed).toBe(0x03ff);
  });

  test("keymap is bijective: slot_index 0..9 <-> Digit1..Digit0 <-> modes 1..10", () => {
    expect(KEYMAP_SLOTS.map((slot) => slot.slotIndex)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(KEYMAP_SLOTS.map((slot) => slot.keyCode)).toEqual([
      "Digit1",
      "Digit2",
      "Digit3",
      "Digit4",
      "Digit5",
      "Digit6",
      "Digit7",
      "Digit8",
      "Digit9",
      "Digit0",
    ]);
    expect(KEYMAP_SLOTS.map((slot) => slot.mode)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(
      KEYMAP_SLOTS.slice(0, DASHBOARD_TAB_IDS.length).map(
        (slot) => slot.modeId,
      ),
    ).toEqual([...DASHBOARD_TAB_IDS]);
    expect(
      codeOf(() =>
        parseTokensV13(mutate('key_code = "Digit0"', 'key_code = "Digit9"')),
      ),
    ).toBe("ERR_A11Y_FOCUS_TRAP_LOOP");
    expect(
      codeOf(() =>
        parseTokensV13(mutate('mode_id = "thresholds"', 'mode_id = "alerts"')),
      ),
    ).toBe("ERR_A11Y_FOCUS_TRAP_LOOP");
  });
});

describe("perceptual gate", () => {
  const report = auditA11y(ssot);

  test("no violations on the committed tokens", () => {
    expect(report.violations).toEqual([]);
    expect(() => assertA11yGates(ssot)).not.toThrow();
  });

  test("body text >= 4.5:1 on every surface", () => {
    const rows = report.contrast.filter((row) =>
      row.check.startsWith("body-text"),
    );
    expect(rows.length).toBe(3 * 7);
    for (const row of rows) expect(row.ratio).toBeGreaterThanOrEqual(4.5);
  });

  test("#94a3b8 on #0b1120 >= 7.0:1 (AAA)", () => {
    const ratio = wcagContrastRatio(
      AAA_MUTED_PAIR.foreground,
      AAA_MUTED_PAIR.background,
    );
    expect(ratio).toBeGreaterThanOrEqual(7.0);
    expect(ratio).toBeCloseTo(7.3437, 3);
  });

  test("interactive borders and badges >= 3.0:1", () => {
    const rows = report.contrast.filter(
      (row) =>
        row.check.startsWith("interactive") || row.check.startsWith("badge"),
    );
    expect(rows.length).toBe(2 * 7 + 4 * 2);
    for (const row of rows) expect(row.ratio).toBeGreaterThanOrEqual(3.0);
  });

  test("cross-state dE00 >= 7.0 and SLA_FRESH vs SLA_STALE dE00 >= 40.0", () => {
    const crossState = report.deltas.filter((row) =>
      row.check.startsWith("cross-state"),
    );
    expect(crossState.length).toBe(3);
    for (const row of crossState)
      expect(row.deltaE00).toBeGreaterThanOrEqual(7.0);
    const freshStale = report.deltas.find(
      (row) => row.check === "sla fresh->stale",
    );
    expect(freshStale?.deltaE00 ?? 0).toBeGreaterThanOrEqual(40.0);
  });

  test("a failing palette raises ERR_A11Y_CONTRAST_BELOW_FLOOR", () => {
    const dimText = mutate(
      'hex = "#94a3b8"\nrole = "text"',
      'hex = "#475569"\nrole = "text"',
    ).replace('"sd-text-muted" = "#94a3b8"', '"sd-text-muted" = "#475569"');
    const error = (() => {
      try {
        assertA11yGates(parseTokensV13(dimText));
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(A11yGateError);
    expect((error as A11yGateError).code).toBe("ERR_A11Y_CONTRAST_BELOW_FLOOR");

    const closeStale = mutate(
      'hex = "#fbbf24"\nage_ceiling_milli_sla = 5000',
      'hex = "#4ade80"\nage_ceiling_milli_sla = 5000',
    ).replace('"sd-sla-stale" = "#fbbf24"', '"sd-sla-stale" = "#4ade80"');
    const checks = auditA11y(parseTokensV13(closeStale)).violations.map(
      (entry) => entry.check,
    );
    expect(checks).toContain("sla fresh->stale");

    const loosened = mutate(
      "wcag_body_text_min_milli = 4500",
      "wcag_body_text_min_milli = 3000",
    );
    expect(
      auditA11y(parseTokensV13(loosened)).violations.map(
        (entry) => entry.check,
      ),
    ).toContain("gates.wcagBodyTextMinMilli");
  });

  test("a dropped ui_state flag raises ERR_A11Y_FOCUS_TRAP_LOOP", () => {
    expect(
      codeOf(() => parseTokensV13(mutate("mode_thresholds = 9\n", ""))),
    ).toBe("ERR_A11Y_FOCUS_TRAP_LOOP");
  });

  test("contract errors are named", () => {
    expect(() => parseTokensV13('[meta]\nversion = "1.2.0"\n')).toThrow(
      TokensContractError,
    );
  });
});

describe("generated domain-branded-types.ts", () => {
  test("is isolatedDeclarations-compliant", () => {
    const generated = resolve(
      import.meta.dir,
      "../src/generated/domain-branded-types.ts",
    );
    const result = Bun.spawnSync(
      [
        process.execPath,
        "check",
        "--no-script",
        "--isolatedDeclarations",
        "--declaration",
        "--allowJs",
        "false",
        generated,
      ],
      {
        cwd: resolve(import.meta.dir, "../../.."),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(`${result.stdout.toString()}${result.stderr.toString()}`).toContain(
      "No type errors",
    );
    expect(result.exitCode).toBe(0);
  });
});
