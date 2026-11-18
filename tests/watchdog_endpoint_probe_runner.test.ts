import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SPORTSDESK_CORE_HOSTS } from "../lib/bun_dns.ts";
import type { TlsProvenance } from "../lib/tls_provenance.ts";
import {
  evaluateEndpointProbe,
  type EndpointProbeObservation,
} from "../lib/watchdog/endpoint_probe.ts";
import {
  buildLookupOptions,
  buildNextState,
  classifyPaging,
  formatIpForUrl,
  parseBackend,
  parseOptions,
  probeWebSocket,
  readBodyFragments,
  readState,
  renderJson,
  renderWsJson,
  selectTargets,
} from "../scripts/watchdog_endpoint_probe.ts";

describe("endpoint probe runner options", () => {
  test("defaults are c-ares, no host filter, and the scratch state path", () => {
    const options = parseOptions([]);
    expect(options.backend).toBe("default");
    expect(options.hosts).toEqual([]);
    expect(options.port).toBeUndefined();
    expect(options.ip).toBeUndefined();
    expect(options.allIps).toBe(false);
    expect(options.httpVersion).toBe("auto");
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

  test("default leaves the backend unset, with tcp and the target port", () => {
    const options = buildLookupOptions(8_443, "default");
    expect(options).toEqual({ port: 8_443, socketType: "tcp" });
    expect("backend" in options).toBe(false);
  });

  test("a backend override is carried explicitly", () => {
    expect(buildLookupOptions(443, "c-ares")).toEqual({
      backend: "c-ares",
      port: 443,
      socketType: "tcp",
    });
  });

  test("port and ip overrides require one host and --dry-run", () => {
    const options = parseOptions([
      "--dry-run",
      "--host",
      "api.telegram.org",
      "--port",
      "8443",
      "--ip",
      "149.154.166.110",
    ]);
    expect(options.port).toBe(8_443);
    expect(options.ip).toBe("149.154.166.110");

    expect(() =>
      parseOptions(["--host", "api.telegram.org", "--port", "8443"]),
    ).toThrow(/require --dry-run/);
    expect(() => parseOptions(["--dry-run", "--port", "8443"])).toThrow(
      /exactly one --host/,
    );
    expect(() =>
      parseOptions([
        "--dry-run",
        "--host",
        "api.telegram.org",
        "--host",
        "clob.polymarket.com",
        "--ip",
        "1.1.1.1",
      ]),
    ).toThrow(/exactly one --host/);
    expect(() =>
      parseOptions(["--dry-run", "--host", "api.telegram.org", "--port", "0"]),
    ).toThrow(/invalid --port/);
    expect(() =>
      parseOptions([
        "--dry-run",
        "--host",
        "api.telegram.org",
        "--port",
        "70000",
      ]),
    ).toThrow(/invalid --port/);
    expect(() =>
      parseOptions([
        "--dry-run",
        "--host",
        "api.telegram.org",
        "--ip",
        "999.1.1.1",
      ]),
    ).toThrow(/invalid --ip/);
  });

  test("--all-ips is diagnostic too", () => {
    const options = parseOptions([
      "--dry-run",
      "--host",
      "api.telegram.org",
      "--all-ips",
    ]);
    expect(options.allIps).toBe(true);
    expect(() =>
      parseOptions(["--host", "api.telegram.org", "--all-ips"]),
    ).toThrow(/require --dry-run/);
    expect(() => parseOptions(["--dry-run", "--all-ips"])).toThrow(
      /exactly one --host/,
    );
  });

  test("--http-version normalizes aliases and requires dry-run/host", () => {
    expect(
      parseOptions([
        "--dry-run",
        "--host",
        "api.telegram.org",
        "--http-version",
        "h2",
      ]).httpVersion,
    ).toBe("http2");
    expect(
      parseOptions([
        "--dry-run",
        "--host",
        "api.telegram.org",
        "--http-version",
        "http3",
      ]).httpVersion,
    ).toBe("http3");
    expect(() =>
      parseOptions([
        "--dry-run",
        "--host",
        "api.telegram.org",
        "--http-version",
        "nope",
      ]),
    ).toThrow(/invalid --http-version/);
    expect(() =>
      parseOptions(["--host", "api.telegram.org", "--http-version", "http2"]),
    ).toThrow(/require --dry-run/);
    expect(() =>
      parseOptions(["--dry-run", "--http-version", "http2"]),
    ).toThrow(/exactly one --host/);
  });

  test("brackets IPv6 for the URL authority", () => {
    expect(formatIpForUrl("149.154.166.110")).toBe("149.154.166.110");
    expect(formatIpForUrl("2001:db8::1")).toBe("[2001:db8::1]");
  });

  test("rejects an unknown backend with the allowed list", () => {
    expect(parseBackend("default")).toBe("default");
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
  test("a missing file is an empty v2 state, not an error", () => {
    const dir = mkdtempSync(join(tmpdir(), "endpoint-probe-"));
    try {
      expect(readState(join(dir, "missing.json"))).toEqual({
        schemaVersion: 2,
        hosts: {},
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("migrates v1, reads v2, and refuses other schemas or bad entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "endpoint-probe-"));
    try {
      const path = join(dir, "state.json");

      writeFileSync(
        path,
        JSON.stringify({
          schemaVersion: 1,
          hosts: {
            "api.telegram.org": {
              consecutiveFailures: 2,
              lastCheckedAtMs: 123,
            },
          },
        }),
      );
      expect(readState(path).hosts["api.telegram.org"]).toEqual({
        consecutiveFailures: 2,
        lastCheckedAtMs: 123,
        alerted: true,
      });

      writeFileSync(
        path,
        JSON.stringify({
          schemaVersion: 2,
          hosts: {
            "api.telegram.org": {
              consecutiveFailures: 1,
              lastCheckedAtMs: 123,
              alerted: false,
            },
          },
        }),
      );
      expect(readState(path).hosts["api.telegram.org"]).toEqual({
        consecutiveFailures: 1,
        lastCheckedAtMs: 123,
        alerted: false,
      });

      writeFileSync(path, JSON.stringify({ schemaVersion: 3, hosts: {} }));
      expect(() => readState(path)).toThrow(/schemaVersion/);

      writeFileSync(
        path,
        JSON.stringify({
          schemaVersion: 2,
          hosts: {
            "api.telegram.org": {
              consecutiveFailures: -1,
              alerted: false,
            },
          },
        }),
      );
      expect(() => readState(path)).toThrow(/consecutiveFailures/);

      writeFileSync(
        path,
        JSON.stringify({
          schemaVersion: 2,
          hosts: {
            "api.telegram.org": {
              consecutiveFailures: 1,
              lastCheckedAtMs: 1,
            },
          },
        }),
      );
      expect(() => readState(path)).toThrow(/alerted/);
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
      state: { consecutiveFailures: 2, lastCheckedAtMs: 1_000, alerted: true },
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
        schemaVersion: 2,
        hosts: {
          [probed.hostname]: {
            consecutiveFailures: 2,
            lastCheckedAtMs: 1_000,
            alerted: true,
          },
          [preserved.hostname]: {
            consecutiveFailures: 1,
            lastCheckedAtMs: 2_000,
            alerted: false,
          },
          "retired.example": {
            consecutiveFailures: 5,
            lastCheckedAtMs: 3_000,
            alerted: true,
          },
        },
      },
      [verdict],
      {},
    );

    expect(next.hosts[probed.hostname]).toEqual({
      consecutiveFailures: 0,
      lastCheckedAtMs: 3_000,
      alerted: false,
    });
    expect(next.hosts[preserved.hostname]).toEqual({
      consecutiveFailures: 1,
      lastCheckedAtMs: 2_000,
      alerted: false,
    });
    expect(next.hosts["retired.example"]).toBeUndefined();
  });
});

describe("endpoint probe paging transitions", () => {
  const target = SPORTSDESK_CORE_HOSTS[0];
  if (target === undefined) throw new Error("core hosts fixture is empty");

  const healthy = (priorFailures: number) =>
    evaluateEndpointProbe({
      nowMs: 2_000,
      state: {
        consecutiveFailures: priorFailures,
        lastCheckedAtMs: 1_000,
        alerted: priorFailures >= 2,
      },
      observation: {
        target,
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

  const failing = (priorFailures: number) =>
    evaluateEndpointProbe({
      nowMs: 2_000,
      state: {
        consecutiveFailures: priorFailures,
        lastCheckedAtMs: 1_000,
        alerted: priorFailures >= 2,
      },
      observation: {
        target,
        lookup: { ok: false, addresses: [], ttlSeconds: [], error: "nxdomain" },
        fetch: { ok: false, status: null, latencyMs: null, error: "nxdomain" },
        cacheStats: null,
      },
    });

  const state = (priorFailures: number) => ({
    schemaVersion: 2 as const,
    hosts: {
      [target.hostname]: {
        consecutiveFailures: priorFailures,
        lastCheckedAtMs: 1_000,
        alerted: priorFailures >= 2,
      },
    },
  });

  test("a first alert pages once and marks the host alerted", () => {
    const decision = classifyPaging(state(1), [failing(1)]);
    expect(decision.newAlerts).toHaveLength(1);
    expect(decision.recoveries).toHaveLength(0);
    expect(decision.nextAlerted[target.hostname]).toBe(true);
  });

  test("a continuing alert does not page again", () => {
    const decision = classifyPaging(state(2), [failing(2)]);
    expect(decision.newAlerts).toHaveLength(0);
    expect(decision.recoveries).toHaveLength(0);
    expect(decision.nextAlerted[target.hostname]).toBe(true);
  });

  test("a recovery pages once and clears the alerted flag", () => {
    const decision = classifyPaging(state(2), [healthy(2)]);
    expect(decision.newAlerts).toHaveLength(0);
    expect(decision.recoveries).toHaveLength(1);
    expect(decision.nextAlerted[target.hostname]).toBe(false);
  });

  test("a below-threshold failure after an alert is not a recovery", () => {
    const verdict = evaluateEndpointProbe({
      nowMs: 2_000,
      state: { consecutiveFailures: 0, lastCheckedAtMs: 1_000, alerted: true },
      observation: {
        target,
        lookup: { ok: false, addresses: [], ttlSeconds: [], error: "nxdomain" },
        fetch: { ok: false, status: null, latencyMs: null, error: "nxdomain" },
        cacheStats: null,
      },
    });
    expect(verdict.status).toBe("ok");
    expect(verdict.code).toBe("lookup-failed");
    const decision = classifyPaging(
      {
        schemaVersion: 2,
        hosts: {
          [target.hostname]: {
            consecutiveFailures: 0,
            lastCheckedAtMs: 1_000,
            alerted: true,
          },
        },
      },
      [verdict],
    );
    expect(decision.recoveries).toHaveLength(0);
    expect(decision.nextAlerted[target.hostname]).toBe(true);
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
      state: { consecutiveFailures: 0, lastCheckedAtMs: null, alerted: false },
      observation: healthy,
    });
    const alertVerdict = evaluateEndpointProbe({
      nowMs: 2_000,
      state: { consecutiveFailures: 1, lastCheckedAtMs: 1_000, alerted: false },
      observation: failing,
    });
    const json = renderJson(
      2_000,
      true,
      "c-ares",
      [okVerdict, alertVerdict],
      null,
      false,
      {},
      {},
      "auto",
    );

    expect(json.resolver).toBe("c-ares");
    expect(json.socketType).toBe("tcp");
    expect(json.ip).toBeNull();
    expect(json.allIps).toBe(false);
    expect(json.mode).toBe("http");
    expect(json.wsUrl).toBeNull();
    expect(json.hosts[0]?.addressProbes).toEqual([]);
    expect(json.hosts[0]?.tls).toBeNull();
    expect(json.hosts[0]?.tlsError).toBeNull();
    expect(json.hosts[0]?.body).toBeNull();
    expect(json.httpVersion).toBe("auto");
    expect(json.dryRun).toBe(true);
    expect(json.alerts).toBe(1);
    expect(json.hosts).toHaveLength(2);
    expect(json.hosts[0]?.ttlSeconds).toEqual([60]);
    expect(json.hosts[1]?.code).toBe("lookup-failed");
    expect(json.hosts[1]?.consecutiveFailures).toBe(2);
  });

  test("per-address probes render without changing the verdict", () => {
    const target = SPORTSDESK_CORE_HOSTS[0];
    if (target === undefined) throw new Error("core hosts fixture is empty");
    const verdict = evaluateEndpointProbe({
      nowMs: 2_000,
      state: { consecutiveFailures: 0, lastCheckedAtMs: null, alerted: false },
      observation: {
        target,
        lookup: {
          ok: true,
          addresses: ["149.154.166.110"],
          ttlSeconds: [60],
          error: null,
        },
        fetch: { ok: true, status: 302, latencyMs: 12, error: null },
        cacheStats: null,
      },
    });
    const json = renderJson(
      2_000,
      true,
      "c-ares",
      [verdict],
      "149.154.166.110",
      true,
      {
        [target.hostname]: [
          {
            address: "149.154.166.110",
            family: 4,
            status: 302,
            latencyMs: 12,
            error: null,
            tls: null,
            tlsError: null,
            body: null,
          },
        ],
      },
      {},
      "auto",
    );
    expect(json.allIps).toBe(true);
    expect(json.ip).toBe("149.154.166.110");
    expect(json.hosts[0]?.addressProbes).toHaveLength(1);
    expect(json.hosts[0]?.addressProbes[0]?.status).toBe(302);
  });

  test("--ws-url parses ws/wss and rejects scheme/conflict/no-dry-run", () => {
    expect(
      parseOptions(["--dry-run", "--ws-url", "wss://example.test/ws"]).wsUrl,
    ).toBe("wss://example.test/ws");
    expect(
      parseOptions(["--dry-run", "--ws-url", "ws://127.0.0.1:8080/"]).wsUrl,
    ).toBe("ws://127.0.0.1:8080/");
    expect(() =>
      parseOptions(["--dry-run", "--ws-url", "https://example.test/ws"]),
    ).toThrow(/must use ws:\/\/ or wss:\/\//);
    expect(() => parseOptions(["--ws-url", "wss://example.test/ws"])).toThrow(
      /requires --dry-run/,
    );
    expect(() =>
      parseOptions([
        "--dry-run",
        "--host",
        "api.telegram.org",
        "--ws-url",
        "wss://example.test/ws",
      ]),
    ).toThrow(/cannot be combined/);
  });

  test("reads text body fragments and caps a large body", async () => {
    const small = await readBodyFragments(
      new Response("hello", { headers: { "content-type": "text/plain" } }),
    );
    expect(small.bytes).toBe(5);
    expect(small.textPreview).toBe("hello");
    expect(small.truncated).toBe(false);
    expect(small.error).toBeNull();

    const large = await readBodyFragments(
      new Response("x".repeat(70_000), {
        headers: { "content-type": "text/plain" },
      }),
    );
    expect(large.truncated).toBe(true);
    expect(large.bytes).toBeGreaterThanOrEqual(64 * 1024);
    expect(large.textPreview?.length).toBe(256);

    const binary = await readBodyFragments(
      new Response(new Uint8Array([0, 1, 2]), {
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    expect(binary.bytes).toBe(3);
    expect(binary.textPreview).toBeNull();
  });

  test("a WebSocket upgrade opens against a local server", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request, server) {
        return server.upgrade(request)
          ? undefined
          : new Response("no upgrade", { status: 400 });
      },
      websocket: {
        open() {},
        message() {},
      },
    });
    try {
      const port = server.port;
      if (port === undefined) throw new Error("local server has no port");
      const result = await probeWebSocket(
        `ws://127.0.0.1:${port}/`,
        "127.0.0.1",
        false,
      );
      expect(result.ok).toBe(true);
      expect(result.status).toBe(101);
    } finally {
      server.stop(true);
    }
  });

  test("renderWsJson labels the mode and URL without changing the verdict", () => {
    const target = SPORTSDESK_CORE_HOSTS[0];
    if (target === undefined) throw new Error("core hosts fixture is empty");
    const verdict = evaluateEndpointProbe({
      nowMs: 2_000,
      state: { consecutiveFailures: 0, lastCheckedAtMs: null, alerted: false },
      observation: {
        target,
        lookup: {
          ok: true,
          addresses: ["127.0.0.1"],
          ttlSeconds: [60],
          error: null,
        },
        fetch: { ok: true, status: 101, latencyMs: 8, error: null },
        transport: "websocket",
        cacheStats: null,
      },
    });
    const json = renderWsJson(
      2_000,
      verdict,
      "default",
      { tls: null, tlsError: "ws:// is plaintext (no TLS)" },
      "ws://127.0.0.1:8080/",
    );
    expect(json.mode).toBe("websocket");
    expect(json.wsUrl).toBe("ws://127.0.0.1:8080/");
    expect(json.hosts[0]?.fetchStatus).toBe(101);
    expect(json.hosts[0]?.message).toContain("WS 101");
  });

  test("TLS provenance renders version, cipher, ALPN and certificate", () => {
    const target = SPORTSDESK_CORE_HOSTS[0];
    if (target === undefined) throw new Error("core hosts fixture is empty");
    const verdict = evaluateEndpointProbe({
      nowMs: 2_000,
      state: { consecutiveFailures: 0, lastCheckedAtMs: null, alerted: false },
      observation: {
        target,
        lookup: {
          ok: true,
          addresses: ["149.154.166.110"],
          ttlSeconds: [60],
          error: null,
        },
        fetch: { ok: true, status: 302, latencyMs: 12, error: null },
        cacheStats: null,
      },
    });
    const tls: TlsProvenance = {
      host: "149.154.166.110",
      port: 443,
      tlsVersion: "TLSv1.3",
      cipher: { name: "TLS_AES_128_GCM_SHA256", version: "TLSv1.3" },
      alpn: "h2",
      authorized: true,
      authorizationError: null,
      peer: {
        subjectCommonName: "example.test",
        issuerCommonName: "Test CA",
        issuerOrganisation: "Test",
        validFrom: "Nov 01 00:00:00 2026 GMT",
        validTo: "Feb 01 00:00:00 2027 GMT",
        fingerprintSha256: "AA:BB:CC",
      },
      sessionReused: false,
      connectMs: 12,
      measuredAt: "2026-11-17T00:00:00.000Z",
    };
    const json = renderJson(
      2_000,
      true,
      "c-ares",
      [verdict],
      null,
      false,
      {},
      { [target.hostname]: { tls, tlsError: null } },
      "auto",
    );
    expect(json.hosts[0]?.tls?.tlsVersion).toBe("TLSv1.3");
    expect(json.hosts[0]?.tls?.alpn).toBe("h2");
    expect(json.hosts[0]?.tls?.authorized).toBe(true);
    expect(json.hosts[0]?.tls?.peer?.validTo).toBe("Feb 01 00:00:00 2027 GMT");
    expect(json.hosts[0]?.tlsError).toBeNull();
  });
});
