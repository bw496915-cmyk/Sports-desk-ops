import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SPORTSDESK_CORE_HOSTS } from "../lib/bun_dns.ts";
import {
  evaluateEndpointProbe,
  type EndpointProbeObservation,
} from "../lib/watchdog/endpoint_probe.ts";
import {
  buildNextState,
  parseBackend,
  parseOptions,
  readState,
  renderJson,
  selectTargets,
} from "../scripts/watchdog_endpoint_probe.ts";

describe("endpoint probe runner options", () => {
  test("defaults are c-ares, no host filter, and the scratch state path", () => {
    const options = parseOptions([]);
    expect(options.backend).toBe("c-ares");
    expect(options.hosts).toEqual([]);
    expect(options.json).toBe(false);
    expect(options.dryRun).toBe(false);
    expect(options.help).toBe(false);
    expect(
      options.statePath.endsWith("scratch/watchdog/endpoint-probe-state.json"),
    ).toBe(true);
  });

  test("parses hosts, backend, dry-run, json and state", () => {
    const options = parseOptions([
      "--host",
      "api.telegram.org",
      "--host",
      "clob.polymarket.com",
      "--backend",
      "system",
      "--dry-run",
      "--json",
      "--state",
      "/tmp/endpoint-probe-test.json",
    ]);
    expect(options.hosts).toEqual(["api.telegram.org", "clob.polymarket.com"]);
    expect(options.backend).toBe("system");
    expect(options.dryRun).toBe(true);
    expect(options.json).toBe(true);
    expect(options.statePath).toBe(resolve("/tmp/endpoint-probe-test.json"));
  });

  test("rejects an unknown backend with the allowed list", () => {
    expect(() => parseBackend("nope")).toThrow(/invalid --backend "nope"/);
    expect(() => parseBackend("nope")).toThrow(
      /c-ares, system, getaddrinfo, libc/,
    );
  });
});

describe("endpoint probe target selection", () => {
  test("no filter selects every core host", () => {
    expect(selectTargets([])).toHaveLength(SPORTSDESK_CORE_HOSTS.length);
  });

  test("a filter selects exactly that core host", () => {
    const targets = selectTargets(["api.telegram.org"]);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.hostname).toBe("api.telegram.org");
  });

  test("an unknown host fails closed with the allowed list", () => {
    expect(() => selectTargets(["nope.example"])).toThrow(/unknown --host/);
    expect(() => selectTargets(["nope.example"])).toThrow(/fantasy402\.com/);
  });
});

describe("endpoint probe state file", () => {
  test("a missing file is an empty state, not an error", () => {
    const dir = mkdtempSync(join(tmpdir(), "endpoint-probe-"));
    try {
      expect(readState(join(dir, "missing.json"))).toEqual({
        schemaVersion: 1,
        hosts: {},
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads a valid state and refuses a bad schema or bad entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "endpoint-probe-"));
    try {
      const path = join(dir, "state.json");
      writeFileSync(
        path,
        JSON.stringify({
          schemaVersion: 1,
          hosts: {
            "api.telegram.org": {
              consecutiveFailures: 1,
              lastCheckedAtMs: 123,
            },
          },
        }),
      );
      expect(readState(path).hosts["api.telegram.org"]).toEqual({
        consecutiveFailures: 1,
        lastCheckedAtMs: 123,
      });

      writeFileSync(path, JSON.stringify({ schemaVersion: 2, hosts: {} }));
      expect(() => readState(path)).toThrow(/schemaVersion/);

      writeFileSync(
        path,
        JSON.stringify({
          schemaVersion: 1,
          hosts: { "api.telegram.org": { consecutiveFailures: -1 } },
        }),
      );
      expect(() => readState(path)).toThrow(/consecutiveFailures/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("endpoint probe state transition", () => {
  test("updates probed hosts, preserves unprobed core hosts, prunes retired", () => {
    const probed = SPORTSDESK_CORE_HOSTS[0];
    const preserved = SPORTSDESK_CORE_HOSTS[1];
    if (probed === undefined || preserved === undefined) {
      throw new Error("core hosts fixture is too small");
    }

    const verdict = evaluateEndpointProbe({
      nowMs: 3_000,
      state: { consecutiveFailures: 2, lastCheckedAtMs: 1_000 },
      observation: {
        target: probed,
        lookup: {
          ok: true,
          addresses: ["203.0.113.10"],
          ttlSeconds: [60],
          error: null,
        },
        fetch: { ok: true, status: 200, latencyMs: 10, error: null },
        cacheStats: null,
      },
    });

    const next = buildNextState(
      {
        schemaVersion: 1,
        hosts: {
          [probed.hostname]: {
            consecutiveFailures: 2,
            lastCheckedAtMs: 1_000,
          },
          [preserved.hostname]: {
            consecutiveFailures: 1,
            lastCheckedAtMs: 2_000,
          },
          "retired.example": {
            consecutiveFailures: 5,
            lastCheckedAtMs: 3_000,
          },
        },
      },
      [verdict],
    );

    expect(next.hosts[probed.hostname]).toEqual({
      consecutiveFailures: 0,
      lastCheckedAtMs: 3_000,
    });
    expect(next.hosts[preserved.hostname]).toEqual({
      consecutiveFailures: 1,
      lastCheckedAtMs: 2_000,
    });
    expect(next.hosts["retired.example"]).toBeUndefined();
  });
});

describe("endpoint probe JSON rendering", () => {
  test("reports the resolver, alerts and per-host diagnostics", () => {
    const target = SPORTSDESK_CORE_HOSTS[0];
    if (target === undefined) throw new Error("core hosts fixture is empty");

    const healthy: EndpointProbeObservation = {
      target,
      lookup: {
        ok: true,
        addresses: ["203.0.113.10"],
        ttlSeconds: [60],
        error: null,
      },
      fetch: { ok: true, status: 200, latencyMs: 10, error: null },
      cacheStats: null,
    };
    const failing: EndpointProbeObservation = {
      target,
      lookup: { ok: false, addresses: [], ttlSeconds: [], error: "nxdomain" },
      fetch: { ok: false, status: null, latencyMs: null, error: "nxdomain" },
      cacheStats: null,
    };

    const okVerdict = evaluateEndpointProbe({
      nowMs: 1_000,
      state: { consecutiveFailures: 0, lastCheckedAtMs: null },
      observation: healthy,
    });
    const alertVerdict = evaluateEndpointProbe({
      nowMs: 2_000,
      state: { consecutiveFailures: 1, lastCheckedAtMs: 1_000 },
      observation: failing,
    });
    const json = renderJson(2_000, true, "c-ares", [okVerdict, alertVerdict]);

    expect(json.resolver).toBe("c-ares");
    expect(json.dryRun).toBe(true);
    expect(json.alerts).toBe(1);
    expect(json.hosts).toHaveLength(2);
    expect(json.hosts[0]?.ttlSeconds).toEqual([60]);
    expect(json.hosts[1]?.code).toBe("lookup-failed");
    expect(json.hosts[1]?.consecutiveFailures).toBe(2);
  });
});
