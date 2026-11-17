import { describe, expect, test } from "bun:test";

import type { HostTarget } from "../lib/bun_dns.ts";
import {
  ENDPOINT_PROBE_DEFAULT_FAIL_THRESHOLD,
  ENDPOINT_PROBE_INTERVAL_SECONDS,
  evaluateEndpointProbe,
  type EndpointProbeFetch,
  type EndpointProbeLookup,
  type EndpointProbeObservation,
  type EndpointProbeState,
} from "../lib/watchdog/endpoint_probe.ts";

const TARGET: HostTarget = {
  hostname: "probe.example",
  port: 443,
  serviceName: "Probe endpoint",
};

const OK_LOOKUP: EndpointProbeLookup = {
  ok: true,
  addresses: ["203.0.113.10"],
  ttlSeconds: [300],
  error: null,
};

const OK_FETCH: EndpointProbeFetch = {
  ok: true,
  status: 200,
  latencyMs: 12,
  error: null,
};

const OK_CACHE = {
  cacheHitsCompleted: 1,
  cacheHitsInflight: 0,
  cacheMisses: 0,
  size: 1,
  errors: 0,
  totalCount: 1,
} as const;

function observation(
  overrides: {
    readonly lookup?: EndpointProbeLookup;
    readonly fetch?: EndpointProbeFetch;
    readonly cacheStats?: Readonly<Record<string, number>> | null;
  } = {},
): EndpointProbeObservation {
  return {
    target: TARGET,
    lookup: overrides.lookup ?? OK_LOOKUP,
    fetch: overrides.fetch ?? OK_FETCH,
    cacheStats:
      overrides.cacheStats === undefined ? OK_CACHE : overrides.cacheStats,
  };
}

function state(consecutiveFailures = 0): EndpointProbeState {
  return { consecutiveFailures, lastCheckedAtMs: 1_700_000_000_000 };
}

describe("evaluateEndpointProbe", () => {
  test("a healthy observation is ok, resets the counter and names the host", () => {
    const verdict = evaluateEndpointProbe({
      nowMs: 2_000,
      state: state(1),
      observation: observation(),
    });
    expect(verdict.status).toBe("ok");
    expect(verdict.code).toBeNull();
    expect(verdict.consecutiveFailures).toBe(0);
    expect(verdict.checkedAtMs).toBe(2_000);
    expect(verdict.message).toContain("probe.example: ok");
    expect(verdict.message).toContain("HTTP 200");
    expect(verdict.message).not.toContain("ALERT");
    expect(verdict.ttlSeconds).toEqual([300]);
  });

  test("one lookup failure stays below the threshold and does not alert", () => {
    const verdict = evaluateEndpointProbe({
      nowMs: 2_000,
      state: state(0),
      observation: observation({
        lookup: {
          ok: false,
          addresses: [],
          ttlSeconds: [],
          error: "getaddrinfo EAI_AGAIN",
        },
      }),
    });
    expect(verdict.status).toBe("ok");
    expect(verdict.code).toBe("lookup-failed");
    expect(verdict.consecutiveFailures).toBe(1);
    expect(verdict.message).toContain("1/2 consecutive failures");
    expect(verdict.message).toContain("EAI_AGAIN");
    expect(verdict.message).not.toContain("ALERT");
  });

  test("a second consecutive lookup failure alerts", () => {
    const verdict = evaluateEndpointProbe({
      nowMs: 2_000,
      state: state(1),
      observation: observation({
        lookup: {
          ok: false,
          addresses: [],
          ttlSeconds: [],
          error: "getaddrinfo EAI_AGAIN",
        },
      }),
    });
    expect(verdict.status).toBe("alert");
    expect(verdict.code).toBe("lookup-failed");
    expect(verdict.consecutiveFailures).toBe(
      ENDPOINT_PROBE_DEFAULT_FAIL_THRESHOLD,
    );
    expect(verdict.message.startsWith("ALERT ")).toBe(true);
    expect(verdict.message).toContain("2/2 consecutive failures");
  });

  test("a success after a failure resets the counter", () => {
    const verdict = evaluateEndpointProbe({
      nowMs: 2_000,
      state: state(1),
      observation: observation(),
    });
    expect(verdict.consecutiveFailures).toBe(0);
    expect(verdict.status).toBe("ok");
  });

  test("fetch failures are distinct from DNS failures", () => {
    const verdict = evaluateEndpointProbe({
      nowMs: 2_000,
      state: state(0),
      observation: observation({
        fetch: { ok: false, status: null, latencyMs: 5_000, error: "timeout" },
      }),
    });
    expect(verdict.code).toBe("fetch-failed");
    expect(verdict.status).toBe("ok");
    expect(verdict.message).toContain("timeout");
  });

  test("a 4xx response is reachable; a 5xx is a server failure", () => {
    const notFound = evaluateEndpointProbe({
      nowMs: 2_000,
      state: state(0),
      observation: observation({
        fetch: { ok: true, status: 404, latencyMs: 8, error: null },
      }),
    });
    expect(notFound.status).toBe("ok");
    expect(notFound.code).toBeNull();
    expect(notFound.message).toContain("HTTP 404");

    const serverError = evaluateEndpointProbe({
      nowMs: 2_000,
      state: state(1),
      observation: observation({
        fetch: { ok: true, status: 503, latencyMs: 8, error: null },
      }),
    });
    expect(serverError.code).toBe("http-server-error");
    expect(serverError.status).toBe("alert");
    expect(serverError.message).toContain("HTTP 503");
  });

  test("resolver TTLs are carried as diagnostics and never gate", () => {
    const verdict = evaluateEndpointProbe({
      nowMs: 2_000,
      state: state(0),
      observation: observation({
        lookup: { ...OK_LOOKUP, ttlSeconds: [0] },
      }),
    });
    expect(verdict.status).toBe("ok");
    expect(verdict.code).toBeNull();
    expect(verdict.ttlSeconds).toEqual([0]);
  });

  test("cache telemetry never changes the verdict", () => {
    const verdict = evaluateEndpointProbe({
      nowMs: 2_000,
      state: state(0),
      observation: observation({
        cacheStats: { cacheHitsCompleted: 0, errors: 99, totalCount: 0 },
      }),
    });
    expect(verdict.status).toBe("ok");
    expect(verdict.code).toBeNull();
    expect(verdict.cacheStats?.errors).toBe(99);
  });

  test("a custom threshold is respected and clamped to at least one", () => {
    const secondOfThree = evaluateEndpointProbe({
      nowMs: 2_000,
      state: state(1),
      failThreshold: 3,
      observation: observation({
        lookup: { ok: false, addresses: [], ttlSeconds: [], error: "nxdomain" },
      }),
    });
    expect(secondOfThree.consecutiveFailures).toBe(2);
    expect(secondOfThree.status).toBe("ok");

    const thirdOfThree = evaluateEndpointProbe({
      nowMs: 2_000,
      state: state(2),
      failThreshold: 3,
      observation: observation({
        lookup: { ok: false, addresses: [], ttlSeconds: [], error: "nxdomain" },
      }),
    });
    expect(thirdOfThree.consecutiveFailures).toBe(3);
    expect(thirdOfThree.status).toBe("alert");

    const clamped = evaluateEndpointProbe({
      nowMs: 2_000,
      state: state(0),
      failThreshold: 0,
      observation: observation({
        lookup: { ok: false, addresses: [], ttlSeconds: [], error: "nxdomain" },
      }),
    });
    expect(clamped.status).toBe("alert");
  });

  test("a negative prior count is clamped, not subtracted", () => {
    const verdict = evaluateEndpointProbe({
      nowMs: 2_000,
      state: state(-5),
      observation: observation({
        lookup: { ok: false, addresses: [], ttlSeconds: [], error: "nxdomain" },
      }),
    });
    expect(verdict.consecutiveFailures).toBe(1);
    expect(verdict.status).toBe("ok");
  });

  test("the interval constant is the 15-minute cadence", () => {
    expect(ENDPOINT_PROBE_INTERVAL_SECONDS).toBe(900);
  });
});
