# Token Architecture & Verification Runbook

Operational and governance standard for token compilation, design systems, verification gates, agent sandbox boundaries, and subprocess execution.

Pinned runtime: Bun 1.4.4+38afee6c8. Observed `Bun.color` output shapes below were checked on this build.

---

## Sandbox / Repository Firewall

Agent sandbox constraints never reach committed code, package.json, hooks, or workflows.

Exploration scripts are ephemeral: they live in /tmp, docs/scratch/, or an untracked path, and never become gates.

A gate is "enforced" only when a runner with access to the gated code executes it and produces an artifact (CI run URL, log, pasted output). Agent reports are claims, not evidence.

When the sandbox cannot reach the code, the work stops at "proposed," and the next step is connecting the code or wiring CI — never substituting a narrower scan and calling it verification.

---

## 1. Single Source of Truth (SSOT) Architecture

All design tokens, RGB color channels, and semantic styling originate strictly from `tokens.toml`:

* **Single Source of Truth (`tokens.toml`):** Master configuration file governing all 13 Qwen3.5-4B (Layers 18–28) neuron design tokens and UI themes.
* **Code Generation (`bun run gen:tokens`):** Compiles `tokens.toml` into downstream TypeScript types (`domain-branded-types.ts`), dashboard CSS variables, and Telegram Mini App properties.
* **Zero-Drift Invariant:** Every CI verification run executes `bun run gen:tokens && git diff --exit-code`. Any manual edit to generated files or uncompiled token definitions fails CI immediately.
* **Cross-Axis Semantic Aliasing:** When domain models introduce secondary palettes (such as 8-tier branch risk grades or account behavioral roles), they must be declared as semantic aliases referencing canonical tokens (e.g., `--color-grade-aaa: var(--sd-theme-emerald)`), never as unmanaged raw RGB definitions in siloed stylesheets.

### 1.2 Bun.color, CSS Houdini @property & :root Architecture

Design tokens span three distinct rendering surfaces compiled synchronously by `scripts/generate_tokens.ts`:

1. **Terminal / CLI Surface (24-bit TrueColor ANSI via `Bun.color`)**:
   * `Bun.color(raw, "number")` validates a hex color string and returns the 24-bit packed integer (`ColorHexInt`, `0xRRGGBB`). On the pinned Bun, `Bun.color("#f59e0b", "number")` returns `16096779` (`0xf59e0b`): a non-negative 24-bit integer with alpha dropped (`#f59e0b80` returns the same number). This shape is observed behavior, not documented in Bun's reference.
   * `Bun.color(raw, "[rgba]")` returns a channel array (`[245, 158, 11, 255]`), not a packed integer.
   * DirectColor ANSI escape sequences come from `Bun.color` directly:
     ```typescript
     const escape = Bun.color(hex, "ansi-16m"); // "\x1b[38;2;245;158;11m" for #f59e0b
     ```
   * Guarantees identical photometric rendering between terminal outputs (`bun sportsdesk_cli.ts -N`) and web interfaces.

2. **DOM / Webview Surface (CSS Houdini `@property` Typed Tokens)**:
   * Every token in `tokens.toml` generates an explicit CSS Houdini `@property` registration in both production dashboards, `customer-churn-simulation-dashboard.html` and `telegram-miniapp-dashboard.html`:
     ```css
     @property --sd-tier-steam {
       syntax: '<color>';
       inherits: true;
       initial-value: #f59e0b;
     }
     ```
   * **Typed Syntax Validation (`syntax: '<color>'`)**: The style engine checks assigned values against `<color>`. Invalid runtime script assignments fail safe to `initial-value`: the engine substitutes the registered initial value instead of rejecting the assignment or corrupting styles.
   * **Smooth Transition Interpolation**: Unregistered two-dash custom properties (`var(--custom)`) behave like string substitution, so transitions on them snap. Registered `<color>` properties let the style engine interpolate the typed color instead of snapping the string ([MDN `@property`](https://developer.mozilla.org/en-US/docs/Web/CSS/@property)). This covers theme transitions, risk escalation badges, and alert pulses. The interpolation happens in the style engine, not the compositor, which only handles `transform`, `opacity`, and `filter`.
   * **Inheritance Control**: `inherits: true` guarantees reliable cascading down DOM component hierarchies.

3. **Canonical `:root` Value Mapping**:
   * Accompanying the `@property` block, `scripts/generate_tokens.ts` generates standard `:root` variable definitions:
     ```css
     :root {
       --sd-tier-steam: #f59e0b;
     }
     ```
   * `@property` is Baseline (all modern browsers since July 2024). The floor is engines that predate it, such as iOS Safari < 16.4 and old Android WebView builds; there the `:root` value still applies, untyped and without interpolation.
   * `:root` provides the unregistered value; `@property` supplies the typed registration and the invalid-value fallback. Value overrides that need older-browser guards belong in `@supports`. An invalid custom property is not discarded like a normal declaration, so a sibling `:root` block is not a value-level fallback.

4. **Automated Registration Verification (`tests/verify_tokens.test.ts`)**:
   * For each of the 13 tokens in `tokens.toml`, CI asserts an `@property` registration and a `:root` declaration in the 2 production dashboards, `customer-churn-simulation-dashboard.html` and `telegram-miniapp-dashboard.html`, and that `initial-value`, the `:root` value and the `tokens.toml` hex resolve to the same `Bun.color(_, "number")`. The registered `@property` set is exactly the `tokens.toml` tokens. Any other `--sd-*` in `:root` (`--sd-primary`, `--sd-accent`, `--sd-danger`, `--sd-warning`, `--sd-purple`) must be a `var(--sd-<token>)` alias of one of them, so it cannot bypass the uniqueness, ΔE00 and contrast gates. `tokens.toml` defines no grade tokens.
   * The prototype `docs/prototypes/sportsdesk-surveillance-dashboard.html` is excluded by design. It lives in the dotfiles repo, where `tests/prototype_boundary.test.ts` keeps it outside `gen:tokens`.
   * `validation/token_validator.ts` checks that every token has a unique packed integer, a $\Delta E_{00} \ge 7.0$ separation floor and WCAG 2.1 contrast. Its `hexToRgb` parses through `Bun.color(_, "{rgb}")` and throws on unparseable input.

---

## 2. Perceptual Distance & Contrast Gates

All color assignments must satisfy automated mathematical validation in `validation/token_validator.ts`:

* **CIEDE2000 Separation Floor:** $\Delta E_{00} \ge 7.0$ across all token pairs to guarantee distinct perceptual legibility on DirectColor terminals and OLED displays.
* **WCAG 2.1 Relative Luminance & Contrast Standards:**
  * **Graphical Components & Badges:** Minimum $3.0:1$ contrast against dark canvas backgrounds (`#070b14` / `#0b1120`).
  * **Body & Table Text Elements:** Minimum $4.5:1$ contrast for standard text; minimum $7.0:1$ for AAA high-legibility elements (e.g. slate-400 `#94a3b8` achieving $7.34:1$).
* **Ordered Risk Spectrum:** Palettes progressing from low to high risk must be documented as an ordered severity spectrum with documented midpoint neutrals, avoiding claims of mathematical $L^*$ or hue monotonicity unless formally verified by test.

---

## 3. Native Bun Toolchain Policy

* **Single Runtime Standard:** All repository scripts, verification gates, linters, and hooks must execute natively on Bun (`#!/usr/bin/env bun`).
* **Zero Secondary Runtimes:** No external scripting runtimes (such as Python, Ruby, or Perl) may be introduced into `package.json`, `.githooks/`, or `.github/workflows/` for repository gating.
* **Native Primitives:** Utilize native Bun APIs (`Bun.Glob`, `Bun.file()`, `Bun.escapeHTML`, `Bun.color()`, `Bun.markdown`) for high-throughput I/O and text processing.

---

## 4. Verification Gate & Denominator Standards

Every static gate and linter must adhere to strict reporting and testing standards:

* **Published Denominators:** Any gate asserting compliance (such as `check-fetch-init.ts`) must publish the complete inspection denominator in its execution log (e.g., `N files scanned, M call sites inspected across K files`). Zero violations without a declared denominator is considered unverified.
* **Planted-Violation Meta-Tests:** Every custom lint rule must be accompanied by an automated meta-test in `tests/` that plants known violations across all supported syntax forms, asserting non-zero exit codes.
* **Pollution-Free Teardown:** Meta-tests creating scratch test files must execute cleanup inside strict `try ... finally` blocks to guarantee working tree cleanliness.

---

## 5. Prototype Governance & Promotion Boundary

* **Prototype Isolation:** Experimental or unmanaged interface artifacts reside strictly under `docs/prototypes/` in the dotfiles repo (not this repo), where `tests/prototype_boundary.test.ts` enforces the boundary, and carry the mandatory file header:
  ```html
  <!-- PROTOTYPE — not in gen:tokens. Maintained as prototype reference under docs/prototypes/ -->
  ```
* **Production Promotion Gate:** A prototype may only be promoted into production webview routes when:
  1. It is registered as an output target in `scripts/generate_tokens.ts` and satisfies the `gen:tokens` zero-diff gate.
  2. All dynamic DOM injection uses safe DOM construction or verified escaping, passing `check-innerhtml.ts`.
  3. External CDNs are removed and assets are bundled locally under a strict Content Security Policy (`default-src 'self'`).
  4. Accessibility audits confirm zero critical/serious violations with full WAI-ARIA behavioral compliance.

---

## 6. Subprocess & Shell Execution Policy

Subprocess execution via `Bun.spawn` and Bun Shell (`$`) must adhere to strict concurrency, security, and lifecycle constraints:

* **Concurrent Stream Draining (Deadlock Prevention):**
  When spawning processes with `stdout: "pipe"` or `stderr: "pipe"`, never await `proc.exited` before reading the streams. Bounded OS pipe buffers (16 KB on macOS, 64 KB on Linux) cause child processes to block indefinitely on `write(2)`. Always drain streams concurrently:
  ```typescript
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    proc.stdout ? proc.stdout.text() : Promise.resolve(""),
    proc.stderr ? proc.stderr.text() : Promise.resolve(""),
  ]);
  ```
* **Deterministic Subprocess Deadlines:**
  Every subprocess invocation must provide a bounded timeout via `signal: AbortSignal.timeout(ms)` to guard against hung child processes blocking hooks or CI runners.
* **Sanitized Environment Inheritance:**
  `Bun.spawn` and `$` inherit `process.env` by default. Outbound processes and git hooks must pass sanitized `env:` mappings or explicit strips to prevent leaking sensitive API tokens (`TELEGRAM_BOT_TOKEN`, `CLOUDFLARE_API_TOKEN`, `F402_PASSWORD`) to child subprocesses.
* **Bun Shell (`$`) API Invariants:**
  * **Pipe Operators:** The pipe operator `|` belongs *inside* the template literal string (`await $`cmd1 | cmd2`.text()`). Bun Shell's `ShellPromise` does **not** expose a `.pipe()` JavaScript method.
  * **Input Redirection & Standard Input:** Bun Shell exposes a `get stdin(): WritableStream` property on `ShellPromise`. Piping arbitrary JavaScript strings or buffers into subprocess stdin must be performed via:
    ```typescript
    // Option A: Passing Blob/Buffer directly to Bun.spawn stdin
    const proc = Bun.spawn(cmd, { stdin: new Blob([payloadString]) });

    // Option B: Using the WritableStream getter writer
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(payloadString));
    await writer.close();
    ```
    Bun Shell redirection also accepts `ReadableStream`, `Blob`, and `Response` objects as expressions (`$`cat < ${blob}``). Never pass arbitrary strings as shell file paths (`< ${fileList}`).
  * **Exit Code Handling:** In test suites, use `.nothrow()` and assert `result.exitCode`. In operational hooks, omit `.nothrow()` (or use `.throws(true)`) to fail immediately on non-zero exits.
