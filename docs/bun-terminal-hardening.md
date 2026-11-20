# Hardening `Bun.Terminal`

Bun documents subprocess limits (`timeout`, `killSignal`, `cgroup`, `AbortSignal`) and
the terminal lifecycle, but there is no PTY-specific security guide. This is the
contract for `TerminalSession` and the dashboard executor (`executeTerminalQuery`).

## Threat model

- **Commands are operator input**, not untrusted network data. Do not feed a request
  parameter, fixture, or model output into `executeTerminalQuery`; that is the
  documented shell-injection boundary.
- The executor splits the typed line into an argv array and calls `Bun.spawn` with an
  array, so there is no implicit `sh -c`. `tests/pty_injection.test.ts` pins that.
  An operator who explicitly types `bash -c '…'` opts into shell semantics.
- A PTY merges stdout, stderr, and stdin into one stream. There is no separate
  stderr buffer to bound or trust.

## Controls

| Control        | Surface                                         | Default                    |
| -------------- | ----------------------------------------------- | -------------------------- |
| `timeout`      | `timeoutMs` on the session/executor             | 10 s (executor)            |
| `killSignal`   | `killSignal` option                             | `SIGTERM`, then escalation |
| Escalation     | `createKillEscalation`                          | `SIGKILL` after 2 s        |
| `AbortSignal`  | `signal` option                                 | none                       |
| `cgroup`       | `cgroup` option or `SPORTSDESK_TERMINAL_CGROUP` | none                       |
| Output cap     | `maxOutputBytes` (opt-in)                       | 4 MiB (executor)           |
| Terminal close | `close()` / `[Symbol.asyncDispose]()`           | awaited after exit         |

## Why the output cap is manual

`maxBuffer` is documented for `Bun.spawnSync` only; the `terminal` option is not
available on `spawnSync`, and async `Bun.spawn` does not apply `maxBuffer` to the PTY
data callback. The only bound is therefore `TerminalSession.maxOutputBytes`, a
byte-accurate tail ring. Reading continues after the cap so the retained bytes are the
end of the stream; `timeout` + escalation, not the cap, bounds CPU.

## Platform notes

- `cgroup` is Linux-only; Bun ignores it elsewhere. It is opt-in because creating and
  configuring the cgroup is the caller's job (usually root or a delegated subtree).
- There is no cgroup equivalent in this stack on macOS.
- `AbortSignal`, `timeout`, and terminal close are portable.

## Non-goals

No seccomp, namespaces, filesystem sandbox, or network isolation. A `Bun.Terminal`
child runs with the dashboard process's privileges; apply OS-level sandboxing outside
Bun if the command is not trusted.

## Verification

- `tests/pty_injection.test.ts` — array-form spawning, no shell injection.
- `lib/bun_terminal.test.ts` — output cap, tail retention, SIGTERM→SIGKILL.
- `tests/terminal_emulator.test.ts` — executor cap, AbortSignal cancellation.
- `tests/kill_escalation.test.ts` — one signal per phase, exit cancellation.

## References

- [Using timeout and killSignal](https://bun.com/docs/runtime/child-process#using-timeout-and-killsignal)
- [Resource limits with cgroups](https://bun.com/docs/runtime/child-process#resource-limits-with-cgroups-linux)
- [Using AbortSignal](https://bun.com/docs/runtime/child-process#using-abortsignal)
- [Terminal (PTY) support](https://bun.com/docs/runtime/child-process#terminal-pty-support)
- [Bun Shell security considerations](https://bun.com/docs/runtime/shell#security-considerations)
