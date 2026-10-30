import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  parseTokensToml,
  parseTokensTomlFromParsed,
} from "../lib/gen_tokens/tokens_ssot.ts";

const rootDir = resolve(import.meta.dir, "..");

describe("parseTokensToml", () => {
  it("parses production tokens.toml with discriminated sla and thresholds", async () => {
    const tomlText = await Bun.file(resolve(rootDir, "tokens.toml")).text();
    const ssot = parseTokensToml(tomlText);

    expect(ssot.meta.version).toBe("1.1.0");
    expect(ssot.surfaces).toHaveLength(2);
    expect(ssot.ingestion).toHaveLength(7);
    expect(ssot.routes).toHaveLength(4);
    expect(ssot.ui).toHaveLength(5);

    const blocked = ssot.ingestion.find((c) => c.layer_id === "L19.N0518");
    expect(blocked?.sla_kind).toBe("sentinel_drop");

    const retail = ssot.ingestion.find((c) => c.layer_id === "L18.N0204");
    expect(retail?.sla_kind).toBe("latency");
    if (retail?.sla_kind === "latency") {
      expect(retail.sla_ms).toBe(1500);
    }

    const r25 = ssot.routes.find((r) => r.layer_id === "L25.N1882");
    expect(r25?.threshold_kind).toBe("consensus_lag");
    if (r25?.threshold_kind === "consensus_lag") {
      expect(r25.max_lag_ms).toBe(5000);
    }

    expect(ssot.ui.every((t) => t.role === "surface" || t.role === "border" || t.role === "text")).toBe(true);
  });

  it("rejects unknown sla_kind", () => {
    expect(() =>
      parseTokensTomlFromParsed({
        meta: { version: "0" },
        surfaces: {},
        ingestion: {
          x: {
            layer_id: "L1.N1",
            token_name: "--t",
            hex: "#000000",
            channel_code: "Internet",
            signal_tier: "S",
            transport_uri: "u",
            channel_status: "ACTIVE",
            volume_rule: "v",
            operational_role: "o",
            sla_kind: "bogus",
          },
        },
        routes: {},
      }),
    ).toThrow(/unknown sla_kind/);
  });

  it("rejects unknown threshold_kind", () => {
    expect(() =>
      parseTokensTomlFromParsed({
        meta: { version: "0" },
        surfaces: {},
        ingestion: {},
        routes: {
          x: {
            layer_id: "L25.N1",
            token_name: "--t",
            hex: "#000000",
            route_name: "r",
            move_flag: "STEAM_CONVERGENCE",
            trigger_kind: "ADVERSE_SELECTION",
            mitigation_kind: "DYNAMIC_REPRICE",
            operational_role: "o",
            threshold_kind: "not_a_kind",
          },
        },
      }),
    ).toThrow(/unknown threshold_kind/);
  });

  it("rejects invalid ui role", () => {
    expect(() =>
      parseTokensTomlFromParsed({
        meta: { version: "0" },
        surfaces: {},
        ingestion: {},
        routes: {},
        ui: {
          x: {
            token_name: "--t",
            hex: "#000000",
            role: "glow",
            description: "d",
          },
        },
      }),
    ).toThrow(/role must be surface/);
  });
});
