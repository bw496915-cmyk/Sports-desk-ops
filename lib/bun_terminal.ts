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

/** Run a command under a PTY; strip CR and ANSI escapes from captured output. */
export async function spawnInPty(
  cmd: readonly string[],
  options: SpawnInPtyOptions = {},
): Promise<PtyRunResult> {
  let out = "";
  const proc = Bun.spawn([...cmd], {
    cwd: options.cwd ?? process.cwd(),
    terminal: {
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
      data(_terminal, data) {
        out += data;
      },
    },
  });
  const code = await proc.exited;
  proc.terminal?.close();
  // eslint-disable-next-line no-control-regex -- PTY tests assert on plain text
  const plain = out.replace(/\r/g, "").replace(/\x1b\[[0-9;]*m/g, "");
  return { code, out: plain };
}
