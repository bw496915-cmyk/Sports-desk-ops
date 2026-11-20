/**
 * @file lib/spawn_sync_bounded.ts
 * @description Drop-in `Bun.spawnSync` wrapper with guardrail defaults.
 *
 * A blocking spawn buffers every byte of output in memory, and without a timeout it
 * can hang the caller forever. `Bun.spawnSync` supports `timeout` and `maxBuffer`,
 * but no call site sets either, so the defaults live here: 60 s and 8 MiB, with
 * SIGKILL on expiry. These are guardrails, not budgets — a known-slow command
 * (full CI, network upload) should pass a larger `timeout`/`maxBuffer` explicitly.
 *
 * Typed as `typeof Bun.spawnSync` so callers keep the overloads and the
 * `stdout: "pipe"` -> `Buffer` narrowing.
 */

export const SPAWN_SYNC_TIMEOUT_MS = 60_000;
export const SPAWN_SYNC_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

type SyncOptions = Bun.SpawnOptions.SpawnSyncOptions<"ignore", "pipe", "pipe">;

interface SyncCommandOptions extends SyncOptions {
  cmd: string[];
}

export const spawnSyncBounded: typeof Bun.spawnSync = ((
  cmdOrOptions: string[] | SyncCommandOptions,
  options: SyncOptions = {},
) => {
  const isCommand = Array.isArray(cmdOrOptions);
  const command = isCommand ? cmdOrOptions : cmdOrOptions.cmd;
  const base = (isCommand ? options : cmdOrOptions) as SyncOptions & {
    cmd?: string[];
  };
  const { cmd: _ignored, ...rest } = base;
  void _ignored;

  return Bun.spawnSync(command, {
    ...rest,
    timeout: rest.timeout ?? SPAWN_SYNC_TIMEOUT_MS,
    maxBuffer: rest.maxBuffer ?? SPAWN_SYNC_MAX_OUTPUT_BYTES,
    killSignal: rest.killSignal ?? "SIGKILL",
  });
}) as typeof Bun.spawnSync;
