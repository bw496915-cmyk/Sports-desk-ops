/**
 * Bun.Terminal PTY helpers — spawn-scoped and reusable terminals.
 *
 * @see {@link BUN_TERMINAL_V14_BLOG_URL}
 * @see {@link BUN_TERMINAL_DOCS}
 * @see tests/cli_terminal_automation.test.ts
 */

export const BUN_TERMINAL_DOCS =
  "https://bun.com/docs/runtime/child-process#terminal-pty-support" as const;

export const BUN_TERMINAL_V14_BLOG_URL =
  "https://bun.sh/blog/bun-v1.4#bun-terminal" as const;

export const BUN_TERMINAL_V14_BLOG_SHIP_NOTE =
  "Bun.Terminal is a built-in pseudo-terminal, so you can drive bash, vim, or htop from JavaScript without node-pty. Pass terminal to Bun.spawn, write input, resize, and read the colored output. It works on Linux, macOS, and Windows." as const;

export const BUN_TERMINAL_SPAWN_PTY_EXAMPLE =
  `const proc = Bun.spawn(["bash"], {
  terminal: {
    cols: 80,
    rows: 24,
    data(term, data) {
      process.stdout.write(data);
    },
  },
});

proc.terminal.write("echo Hello from PTY!\\n");` as const;

export interface SpawnInPtyOptions {
  readonly cwd?: string;
  readonly cols?: number;
  readonly rows?: number;
}

export interface PtyRunResult {
  readonly code: number;
  readonly out: string;
}

export interface SpawnInPtyUntilOptions extends SpawnInPtyOptions {
  /** Stop waiting after this many ms and SIGTERM the child (interactive TUIs). */
  readonly maxMs?: number;
  /** Resolve early when captured output matches (after ANSI strip). */
  readonly untilOutput?: RegExp;
}

export interface PtyRunUntilResult extends PtyRunResult {
  readonly killed: boolean;
  readonly rawBytes: number;
}

/** Strip CR and SGR escapes from PTY capture (assertions on plain text). */
export function stripPtyCapture(raw: string): string {
  // eslint-disable-next-line no-control-regex -- PTY tests assert on plain text
  return raw.replace(/\r/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

/** Run a command under a PTY; strip CR and ANSI escapes from captured output. */
export async function spawnInPty(
  cmd: readonly string[],
  options: SpawnInPtyOptions = {},
): Promise<PtyRunResult> {
  const run = await spawnInPtyUntil(cmd, options);
  return { code: run.code, out: run.out };
}

/**
 * PTY spawn for interactive programs — optional timeout/kill and early exit when output matches.
 */
export async function spawnInPtyUntil(
  cmd: readonly string[],
  options: SpawnInPtyUntilOptions = {},
): Promise<PtyRunUntilResult> {
  let raw = "";
  const proc = Bun.spawn([...cmd], {
    cwd: options.cwd ?? process.cwd(),
    terminal: {
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
      data(_terminal, data) {
        raw += data;
      },
    },
  });

  const maxMs = options.maxMs ?? 0;
  const needsWatch = maxMs > 0 || options.untilOutput !== undefined;
  let killed = false;

  if (needsWatch) {
    await Promise.race([
      proc.exited,
      new Promise<void>((resolve) => {
        const started = Date.now();
        const tick = (): void => {
          const plain = stripPtyCapture(raw);
          if (options.untilOutput?.test(plain)) {
            killed = true;
            proc.kill();
            resolve();
            return;
          }
          if (maxMs > 0 && Date.now() - started >= maxMs) {
            killed = true;
            proc.kill();
            resolve();
            return;
          }
          setTimeout(tick, 50);
        };
        tick();
      }),
    ]);
  }

  const code = await proc.exited;
  proc.terminal?.close();
  const out = stripPtyCapture(raw);
  return { code, out, killed, rawBytes: raw.length };
}

/** Blog pattern: drive an shell with `terminal.write` lines (each should end with `\n`). */
export async function driveBashScript(
  lines: readonly string[],
  options?: SpawnInPtyOptions,
): Promise<PtyRunResult> {
  let raw = "";
  const proc = Bun.spawn(["bash"], {
    cwd: options?.cwd ?? process.cwd(),
    terminal: {
      cols: options?.cols ?? 80,
      rows: options?.rows ?? 24,
      data(_terminal, data) {
        raw += data;
      },
    },
  });
  for (const line of lines) {
    proc.terminal.write(line.endsWith("\n") ? line : `${line}\n`);
  }
  const code = await proc.exited;
  proc.terminal?.close();
  return { code, out: stripPtyCapture(raw) };
}
