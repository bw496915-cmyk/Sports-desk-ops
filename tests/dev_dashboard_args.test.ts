import { describe, expect, test } from "bun:test";
import {
  DASHBOARD_USAGE,
  findRouteKeyCollisions,
  parseDashboardServerArgs,
  resolveDashboardDefaultPort,
  resolveDashboardHostname,
} from "../scripts/dev_dashboard.ts";

describe("dev dashboard CLI args", () => {
  test("accepts space-separated --port and --host", () => {
    expect(
      parseDashboardServerArgs(["--port", "3000", "--host", "0.0.0.0"]),
    ).toMatchObject({ port: 3000, hostname: "0.0.0.0" });
  });

  test("accepts = forms including an IPv6 host", () => {
    expect(
      parseDashboardServerArgs(["--port=4022", "--host=::1"]),
    ).toMatchObject({ port: 4022, hostname: "::1" });
    expect(parseDashboardServerArgs(["--hostname=localhost"])).toMatchObject({
      hostname: "localhost",
    });
  });

  test("keeps the existing boolean flags", () => {
    expect(
      parseDashboardServerArgs([
        "--api-only",
        "--no-dev",
        "--no-hmr",
        "--no-console",
        "--mcp-stateless",
      ]),
    ).toMatchObject({
      apiOnly: true,
      noDev: true,
      noHmr: true,
      noConsole: true,
      mcpStateless: true,
    });
  });

  test("ignores the runtime and script arguments", () => {
    const parsed = parseDashboardServerArgs([
      "/path/to/bun",
      "scripts/dev_dashboard.ts",
      "--port",
      "3000",
    ]);
    expect(parsed.port).toBe(3000);
  });

  test("recognizes help and documents both value forms", () => {
    expect(parseDashboardServerArgs(["-h"]).help).toBe(true);
    expect(parseDashboardServerArgs(["--help"]).help).toBe(true);
    expect(DASHBOARD_USAGE).toContain("--port");
    expect(DASHBOARD_USAGE).toContain("--host");
    expect(DASHBOARD_USAGE).toContain("--port=3000");
  });

  test("port fallback follows BUN_PORT, PORT, NODE_PORT, then 4022", () => {
    expect(
      resolveDashboardDefaultPort({
        BUN_PORT: "4000",
        PORT: "4001",
        NODE_PORT: "4002",
      }),
    ).toBe(4000);
    expect(
      resolveDashboardDefaultPort({ PORT: "4001", NODE_PORT: "4002" }),
    ).toBe(4001);
    expect(resolveDashboardDefaultPort({ NODE_PORT: "4002" })).toBe(4002);
    expect(resolveDashboardDefaultPort({})).toBe(4022);
    expect(
      resolveDashboardDefaultPort({ BUN_PORT: "nope", PORT: "4001" }),
    ).toBe(4001);
    expect(resolveDashboardDefaultPort({ PORT: "70000" })).toBe(4022);
  });

  test("runtime --port (process.execArgv) beats the environment", () => {
    expect(
      resolveDashboardDefaultPort({ BUN_PORT: "4000", PORT: "4001" }, [
        "--port=4500",
      ]),
    ).toBe(4500);
    expect(
      resolveDashboardDefaultPort({ PORT: "4001" }, ["--port", "4501"]),
    ).toBe(4501);
    expect(
      resolveDashboardDefaultPort({ PORT: "4001" }, ["--port=invalid"]),
    ).toBe(4001);
    expect(resolveDashboardDefaultPort({}, ["--smol"])).toBe(4022);
  });

  test("CLI hostname wins over HOST", () => {
    expect(
      resolveDashboardHostname({ hostname: "0.0.0.0" }, { HOST: "::1" }),
    ).toBe("0.0.0.0");
    expect(
      resolveDashboardHostname({ hostname: undefined }, { HOST: "::1" }),
    ).toBe("::1");
    expect(
      resolveDashboardHostname({ hostname: undefined }, { HOST: "  " }),
    ).toBeUndefined();
    expect(
      resolveDashboardHostname({ hostname: undefined }, {}),
    ).toBeUndefined();
  });

  test("detects duplicate exact keys across merged route tables", () => {
    expect(
      findRouteKeyCollisions({
        ui: { "/": 1, "/dashboard": 2 },
        api: { "/api": 3, "/api/*": 4 },
        companion: { "/api": 5 },
      }),
    ).toEqual([{ key: "/api", tables: ["api", "companion"] }]);
    expect(
      findRouteKeyCollisions({
        ui: { "/": 1 },
        api: { "/api": 2 },
        companion: { "/api/*": 3 },
      }),
    ).toEqual([]);
  });

  test("rejects invalid values", () => {
    expect(() => parseDashboardServerArgs(["--port", "abc"])).toThrow(
      /--port must be an integer/,
    );
    expect(() => parseDashboardServerArgs(["--port"])).toThrow(
      /--port requires a value/,
    );
    expect(() => parseDashboardServerArgs(["--port", "70000"])).toThrow(
      /between 0 and 65535/,
    );
    expect(() => parseDashboardServerArgs(["--host="])).toThrow(
      /non-empty value/,
    );
    expect(() => parseDashboardServerArgs(["--host"])).toThrow(
      /--host requires a value/,
    );
  });
});

describe("dev dashboard startup with CLI flags", () => {
  test("--help prints usage and exits 0", async () => {
    const proc = Bun.spawn(
      [process.execPath, "run", "scripts/dev_dashboard.ts", "--help"],
      {
        cwd: joinRepo(),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: bun run dev");
  });

  test("a bind failure is one error and exit 1", async () => {
    const probe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 204 }),
    });
    const port = probe.port;
    if (port === undefined) throw new Error("no ephemeral port");

    const proc = Bun.spawn(
      [
        process.execPath,
        "run",
        "scripts/dev_dashboard.ts",
        "--port",
        String(port),
        "--host",
        "127.0.0.1",
      ],
      {
        cwd: joinRepo(),
        env: {
          ...process.env,
          SPORTSDESK_AUTH_DISABLED: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const killTimer = setTimeout(() => proc.kill("SIGKILL"), 8000);
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(killTimer);
    probe.stop(true);
    if (exitCode !== 1) proc.kill();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("failed to start the dev server");
    expect(stderr.trim().split("\n").length).toBe(1);
  });

  test("honors the Bun runtime --port flag", async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        "--port=0",
        "run",
        "scripts/dev_dashboard.ts",
        "--host",
        "127.0.0.1",
      ],
      {
        cwd: joinRepo(),
        env: {
          ...process.env,
          SPORTSDESK_AUTH_DISABLED: "1",
          SPORTSDESK_LIVE_WAGERS_JSON:
            "tests/fixtures/live-wagers.partial.json",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const killTimer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
    try {
      const url = await readLocalUrl(proc.stdout);
      expect(url).not.toBeNull();
      if (url === null) return;
      const health = new URL("/health", url);
      let ok = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          if ((await fetch(health)).ok) {
            ok = true;
            break;
          }
        } catch {
          // server not ready yet
        }
        await Bun.sleep(100);
      }
      expect(ok).toBe(true);
    } finally {
      clearTimeout(killTimer);
      proc.kill();
    }
  }, 20_000);

  test("--port 0 selects a free port and its logged URL is fetchable", async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        "run",
        "scripts/dev_dashboard.ts",
        "--port",
        "0",
        "--host",
        "127.0.0.1",
      ],
      {
        cwd: joinRepo(),
        env: {
          ...process.env,
          SPORTSDESK_AUTH_DISABLED: "1",
          SPORTSDESK_LIVE_WAGERS_JSON:
            "tests/fixtures/live-wagers.partial.json",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const killTimer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
    try {
      const url = await readLocalUrl(proc.stdout);
      expect(url).not.toBeNull();
      if (url === null) return;

      const health = new URL("/health", url);
      let ok = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          if ((await fetch(health)).ok) {
            ok = true;
            break;
          }
        } catch {
          // server not ready yet
        }
        await Bun.sleep(100);
      }
      expect(ok).toBe(true);
    } finally {
      clearTimeout(killTimer);
      proc.kill();
    }
  }, 20_000);

  test("binds the port and hostname passed on the command line", async () => {
    const probe = Bun.serve({
      port: 0,
      fetch: () => new Response(null, { status: 204 }),
    });
    const port = probe.port;
    probe.stop(true);
    if (port === undefined) throw new Error("no ephemeral port");

    const proc = Bun.spawn(
      [
        process.execPath,
        "run",
        "scripts/dev_dashboard.ts",
        "--port",
        String(port),
        "--host",
        "127.0.0.1",
      ],
      {
        cwd: joinRepo(),
        env: {
          ...process.env,
          SPORTSDESK_AUTH_DISABLED: "1",
          SPORTSDESK_LIVE_WAGERS_JSON:
            "tests/fixtures/live-wagers.partial.json",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const killTimer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
    try {
      const url = await readLocalUrl(proc.stdout);
      expect(url).not.toBeNull();
      if (url === null) return;
      // The bound port comes from the logged server URL, not from rebuilding the
      // address; this asserts the CLI --port value is what Bun actually bound.
      expect(url.port).toBe(String(port));
      const health = new URL("/health", url);
      let ok = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          if ((await fetch(health)).ok) {
            ok = true;
            break;
          }
        } catch {
          // server not ready yet
        }
        await Bun.sleep(100);
      }
      expect(ok).toBe(true);
    } finally {
      clearTimeout(killTimer);
      proc.kill();
    }
  }, 20_000);
});

function joinRepo(): string {
  return new URL("..", import.meta.url).pathname;
}

/** Read stdout until the server logs its `Local URL:`, then stop and release the reader. */
async function readLocalUrl(
  stream: ReadableStream<Uint8Array>,
  timeoutMs = 8000,
): Promise<URL | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const outcome = await Promise.race([
        reader.read(),
        Bun.sleep(remaining).then(() => "timeout" as const),
      ]);
      if (outcome === "timeout") {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      if (outcome.done) return null;
      buffer += decoder.decode(outcome.value, { stream: true });
      const match = /Local URL:\s+(\S+)/.exec(buffer);
      const href = match?.[1];
      if (href !== undefined) return new URL(href);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // reader already cancelled
    }
  }
}
