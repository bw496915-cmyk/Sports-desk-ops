import { describe, expect, test } from "bun:test";

interface PtyResult {
  readonly code: number;
  readonly out: string;
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

async function runInPty(cmd: string[]): Promise<PtyResult> {
  let out = "";
  const proc = Bun.spawn(cmd, {
    cwd: process.cwd(),
    terminal: {
      cols: 120,
      rows: 40,
      data(_terminal, data) {
        out += data;
      },
    },
  });
  const code = await proc.exited;
  proc.terminal.close();
  return { code, out: out.replace(/\r/g, "").replace(ANSI_PATTERN, "") };
}

describe("Bun PTY terminal automation", () => {
  test("the child sees a real TTY", async () => {
    const result = await runInPty([process.execPath, "-e", "console.log(process.stdout.isTTY)"]);
    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe("true");
  });

  test("dx help renders to a PTY", async () => {
    const result = await runInPty(["./bin/dx", "help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("./bin/dx gslive");
    expect(result.out).toContain("./bin/dx docs");
    expect(result.out).toContain("./bin/dx stale");
  });

  test("dx shot --help renders without launching a browser", async () => {
    const result = await runInPty(["./bin/dx", "shot", "--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Bun.WebView screenshot tool");
    expect(result.out).toContain("--f402-login");
  });

  test("dx docs --json parses from PTY output", async () => {    const result = await runInPty(["./bin/dx", "docs", "--json"]);
    expect(result.code).toBe(0);
    const extension = JSON.parse(result.out.trim()) as {
      provider?: string;
      partnerId?: number;
      surfaces?: unknown[];
    };
    expect(extension.provider).toBe("GSLive Manager (Partner 118)");
    expect(extension.partnerId).toBe(118);
    expect(extension.surfaces).toHaveLength(3);
  });
});
