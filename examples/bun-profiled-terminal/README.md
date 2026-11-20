# Profiled terminal engine

A self-contained Bun module for profile-driven terminal work: named color tokens in SQLite,
per-profile `Bun.inspect` settings, reactive profile changes, a Markdown profile card, and PTY
sessions whose children inherit the profile environment.

```sh
bun run examples/bun-profiled-terminal/demo.ts
bun test examples/bun-profiled-terminal/bun-profiled-terminal.test.ts
```

## What it provides

| Feature                                                        | Entry point                                                  |
| :------------------------------------------------------------- | :----------------------------------------------------------- |
| Named color tokens + inspect settings in SQLite                | `NamedColorTokenStore`                                       |
| Profile precedence (explicit → `PTY_*` → SQLite → builtin)     | `resolveTerminalProfile`                                     |
| Host `console.log()` / `Bun.inspect()` sync with scope restore | `applyProfileToHost`                                         |
| Clone, diff, and live change notifications                     | `cloneProfile`, `diffProfiles`, `watchProfile`               |
| Self-contained profile card with live swatches                 | `profile.renderProfileCard()`                                |
| Native Markdown layout and token-colored callbacks             | `profile.renderMarkdown()`, `profile.renderMarkdownThemed()` |
| PTY session with timeouts, abort, capture and Markdown fences  | `runProfiledPtySession`                                      |
| Low-level PTY handle with raw/clean blobs                      | `createProfiledTerminal`                                     |
| PTY capability probe for sandboxed hosts                       | `probePtySupport`                                            |

## Bun 1.4.4 constraints this module works around

Measured 2026-11-18 on `1.4.4+38afee6c8` (arm64-darwin):

- **`Bun.inspect.defaults` does not exist.** `Bun.inspect` accepts only
  `{ colors, depth, sorted, compact }`. `applyProfileToHost()` therefore patches the global
  `console` methods and `Bun.inspect` itself, and restores both through `Disposable`:
  ```ts
  {
    using _host = applyProfileToHost(profile);
    console.log(nested); // profile depth and truncation
  }
  ```
- **`maxArrayLength` and `maxStringLength` are ignored by `Bun.inspect`.** `applyInspectLimits()`
  clones arrays and plain objects with truncation markers before inspection; class instances and
  native handles pass through untouched.
- **`Bun.markdown.ansi()` ignores per-element callbacks.** Its `AnsiTheme` only accepts
  `colors`, `columns`, `hyperlinks`, `light` and `kittyGraphics`. Token-colored callbacks belong to
  `Bun.markdown.render()`, exposed separately as `profile.renderMarkdownThemed()`.
- **`--console-depth=Infinity` is rejected** by the CLI. `toEnv()` omits the flag for an unlimited
  profile and passes `PTY_CONSOLE_DEPTH=Infinity` instead. A profile's finite depth replaces any
  inherited `--console-depth` in `BUN_OPTIONS`, so a stale value cannot silently override it.

## Precedence

```
explicit overrides > PTY_* env > SQLite store > builtin preset > builtin "default"
```

Invalid explicit overrides throw (`ERR_COLOR_INVALID`, `ERR_CONSOLE_DEPTH_INVALID`). Invalid
environment or stored values are skipped and recorded in `profile.warnings`, so a long-running
manager keeps a usable profile instead of failing to start.

## PTY notes

- Commands are spawned with array-form `Bun.spawn`, never a shell wrapper.
- `Bun.Terminal.write()` accepts every byte and buffers the remainder; its return value is not a
  partial-write count, so the runner never re-sends a tail.
- `probePtySupport()` reports `Failed to open PTY` on hosts where `/dev/ptmx` is unavailable
  (for example a file sandbox). The test suite skips the PTY cases there and the demo prints a skip
  line; run with device access to exercise the real path.
- `Bun.Terminal` is capability-detected, not rejected by `process.platform`.
