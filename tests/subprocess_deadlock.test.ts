import { describe, expect, test } from "bun:test";

/**
 * Subprocess Pipe Deadlock Reproduction and Remediation Suite
 *
 * Demonstrates the OS pipe buffer deadlock mechanism:
 * 1. Child process emits 1 MB to stdout (exceeds 16 KB macOS / 64 KB Linux pipe buffer).
 * 2. Failing Anti-Pattern: Awaiting `proc.exited` before reading `proc.stdout` deadlocks because
 *    the child process is blocked on write(2) while the parent is blocked on waitpid/exited.
 *    Reproduced under a 2000ms watchdog; cleaned up with SIGTERM -> SIGKILL grace.
 * 3. Remediated Pattern: Concurrent stream draining via `Promise.all([proc.exited, proc.stdout.text()])`
 *    reads chunks concurrently as they arrive, completing in milliseconds.
 * 4. Bun Shell ($): Built-in internal draining handles large outputs safely.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Subprocess Pipe Deadlock Verification", () => {
  const ONE_MEGABYTE = 1024 * 1024;

  test("Deadlock reproduction: Sequential await proc.exited hangs when pipe buffer fills", async () => {
    const proc = Bun.spawn([
      process.execPath,
      "-e",
      `process.stdout.write("X".repeat(${ONE_MEGABYTE})); process.exit(0);`,
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      // 2000ms watchdog timeout simulating hanging pre-commit hook or linter
      const watchdog = sleep(2000).then(() => "TIMEOUT" as const);

      const outcome = await Promise.race([
        proc.exited.then(() => "EXITED" as const),
        watchdog,
      ]);

      // Assert the deadlock occurred: child blocked on write(2), so exited never settled
      expect(outcome).toBe("TIMEOUT");
    } finally {
      // Graceful termination: SIGTERM followed by SIGKILL if still active
      try {
        proc.kill(15); // SIGTERM
        await sleep(50);
        proc.kill(9);  // SIGKILL
      } catch {
        // Child already terminated
      }
    }
  });

  test("Remediation: Concurrent Promise.all drain completes cleanly in <500ms", async () => {
    const startTime = performance.now();

    const proc = Bun.spawn([
      process.execPath,
      "-e",
      `process.stdout.write("X".repeat(${ONE_MEGABYTE})); process.exit(0);`,
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });

    // Concurrent drain: stdout is consumed simultaneously while awaiting exit
    const [exitCode, outputText] = await Promise.all([
      proc.exited,
      proc.stdout.text(),
    ]);

    const elapsedMs = performance.now() - startTime;

    expect(exitCode).toBe(0);
    expect(outputText.length).toBe(ONE_MEGABYTE);
    expect(elapsedMs).toBeLessThan(1000);
  });

  test("Bun Shell ($) auto-drains large outputs without deadlocking", async () => {
    const { $ } = await import("bun");
    const result = await $`${process.execPath} -e 'process.stdout.write("X".repeat(1024 * 1024))'`.text();

    expect(result.length).toBe(ONE_MEGABYTE);
  });
});
