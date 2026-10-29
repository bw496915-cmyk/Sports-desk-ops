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

- **Single Source of Truth (`tokens.toml`):** Master configuration file governing all 18 Qwen3.5-4B (Layers 18–28) neuron design tokens and UI themes.
- **Code Generation (`bun run gen:tokens`):** Compiles `tokens.toml` into downstream TypeScript types (`domain-branded-types.ts`), dashboard CSS variables, and Telegram Mini App properties.
- **Zero-Drift Invariant:** Every CI verification run executes `bun run gen:tokens && git diff --exit-code`. Any manual edit to generated files or uncompiled token definitions fails CI immediately.
- **Cross-Axis Semantic Aliasing:** When domain models introduce secondary palettes (such as 8-tier branch risk grades or account behavioral roles), they must be declared as semantic aliases referencing canonical tokens (e.g., `--color-grade-aaa: var(--sd-theme-emerald)`), never as unmanaged raw RGB definitions in siloed stylesheets. The one current exception is the out-of-CI prototype (`docs/prototypes/sportsdesk-surveillance-dashboard.html`), which still uses raw channel triples; it must be normalized to aliases (and its 3 new hexes adjudicated) before promotion — see §1.2.

### 1.2 Bun.color, CSS Houdini @property & :root Architecture

Design tokens span three distinct rendering surfaces compiled synchronously by `scripts/generate_tokens.ts`:

1. **Terminal / CLI Surface (24-bit TrueColor ANSI via `Bun.color`)**:
   - `Bun.color(raw, "number")` returns a JavaScript `number` (`typeof` is `"number"`; the domain name `ColorHexInt` is a branded alias of `number`, not a distinct runtime shape): the 24-bit packed value `0xRRGGBB`. On the pinned Bun (`bun --revision` → `1.4.4+38afee6c8`), `Bun.color("#f59e0b", "number")` returns `16096779` (`0xf59e0b`): a non-negative 24-bit integer with alpha dropped (`#f59e0b80` returns the same number). This shape is observed behavior, not documented in Bun's reference.
   - `Bun.color(raw, "[rgba]")` returns a channel array (`[245, 158, 11, 255]`), not a packed integer.
   - DirectColor ANSI escape sequences come from `Bun.color` directly:
     ```typescript
     const escape = Bun.color(hex, "ansi-16m"); // "\x1b[38;2;245;158;11m" for #f59e0b
     ```
   - Guarantees identical photometric rendering between terminal outputs (`bun sportsdesk_cli.ts -N`) and web interfaces.

2. **DOM / Webview Surface (CSS Houdini `@property` Typed Tokens)**:
   - Every token in `tokens.toml` generates an explicit CSS Houdini `@property` registration in both production dashboards, `customer-churn-simulation-dashboard.html` and `telegram-miniapp-dashboard.html`:
     ```css
     @property --sd-tier-steam {
       syntax: "<color>";
       inherits: true;
       initial-value: #f59e0b;
     }
     ```
   - **Typed Syntax Validation (`syntax: '<color>'`)**: The style engine checks assigned values against `<color>`. Invalid runtime script assignments fail safe to `initial-value`: the engine substitutes the registered initial value instead of rejecting the assignment or corrupting styles.
   - **Smooth Transition Interpolation**: Unregistered two-dash custom properties (`var(--custom)`) behave like string substitution, so transitions on them snap. Registered `<color>` properties let the style engine interpolate the typed color instead of snapping the string ([MDN `@property`](https://developer.mozilla.org/en-US/docs/Web/CSS/@property)). This covers theme transitions, risk escalation badges, and alert pulses. The interpolation happens in the style engine, not the compositor, which only handles `transform`, `opacity`, and `filter`.
   - **Inheritance Control**: `inherits: true` guarantees reliable cascading down DOM component hierarchies.

3. **Canonical `:root` Value Mapping**:
   - Accompanying the `@property` block, `scripts/generate_tokens.ts` generates standard `:root` variable definitions:
     ```css
     :root {
       --sd-tier-steam: #f59e0b;
     }
     ```
   - `@property` is Baseline (all modern browsers since July 2024). The floor is engines that predate it, such as iOS Safari < 16.4 and old Android WebView builds; there the `:root` value still applies, untyped and without interpolation.
   - `:root` provides the unregistered value; `@property` supplies the typed registration and the invalid-value fallback. Value overrides that need older-browser guards belong in `@supports`. An invalid custom property is not discarded like a normal declaration, so a sibling `:root` block is not a value-level fallback.

4. **Automated Registration Verification (`tests/verify_tokens.test.ts`)**:
   - For each of the 18 tokens in `tokens.toml`, CI asserts an `@property` registration and a `:root` declaration in the 2 production dashboards, `customer-churn-simulation-dashboard.html` and `telegram-miniapp-dashboard.html`, and that `initial-value`, the `:root` value and the `tokens.toml` hex resolve to the same `Bun.color(_, "number")`. The registered `@property` set is exactly the `tokens.toml` tokens, including the `[ui.*]` chrome tokens (`--sd-surface-card`, `--sd-surface-hover`, `--sd-surface-border`, `--sd-text-primary`, `--sd-text-muted`). Any other `--sd-*` in `:root` (`--sd-primary`, `--sd-accent`, `--sd-danger`, `--sd-warning`, `--sd-purple`, `--sd-text-dim`, `--sd-text-on-fill`) must be a `var(--sd-<token>)` alias of one of them, so it cannot bypass the uniqueness, ΔE00 and contrast gates. Every `var(--sd-*)` a dashboard references must be defined, component CSS and `style=""` attributes may not contain raw color literals, and `role = "text"` UI tokens must reach 4.5:1 on every surface. UI tokens are excluded from the pairwise ΔE00 floor, because neighbouring surfaces are meant to be close. `tokens.toml` defines no grade tokens, and neither production dashboard declares a `--color-grade-*` property. The 8-tier branch-risk grades exist only in the out-of-CI prototype `docs/prototypes/sportsdesk-surveillance-dashboard.html` (dotfiles), as raw RGB channel triples (`--color-grade-aaa-rgb: 16 185 129`, …), not as `var(--sd-*)` aliases. Their ΔE00 status splits:
   - **5 are aliases in effect (vacuous in ΔE00):** `aaa`→`--sd-theme-emerald` (`#10b981`), `a`→`--sd-route-devig` (`#06b6d4`), `bbb`→`--sd-tier-blocked` (`#64748b`), `bb`→`--sd-tier-steam` (`#f59e0b`), `d-toxic`→`--sd-route-manager` (`#f43f5e`). Normalizing them to `var(--sd-*)` before promotion makes ΔE00 evaluate the canonical token only; the grades themselves are vacuous.
   - **3 are new hexes (unadjudicated):** `aa` `#059669`, `b` `#f97316`, `ccc` `#ea580c` are absent from `tokens.toml`. They must be added there and pass the same ΔE00/contrast gates before any promotion, or be replaced with canonical aliases. Decision (2026-10-29): they stay prototype-only — no `tokens.toml` entries until a promotion is requested, at which point they are adjudicated. `tests/prototype_grade_palette.test.ts` in dotfiles pins the 8-token palette and this 5-alias/3-new split so drift is caught.
     Because the prototype is outside `gen:tokens` and CI (`tests/prototype_boundary.test.ts`), the ΔE00 gate currently does not evaluate any of the 8 — that is a boundary exclusion, not a pass.
   - `test_assert_every_registered_sd_property_initial_value_equals_root_value` asserts `initial-value` ↔ `:root` equality for every registered `--sd-*` in both dashboards, in the same 18-test run — this is tested, not out of scope.
   - The prototype `docs/prototypes/sportsdesk-surveillance-dashboard.html` is excluded by design. It lives in the dotfiles repo, where `tests/prototype_boundary.test.ts` keeps it outside `gen:tokens`.
   - `validation/token_validator.ts` checks that every token has a unique packed integer, a $\Delta E_{00} \ge 7.0$ separation floor and WCAG 2.1 contrast. Its `hexToRgb` parses through `Bun.color(_, "{rgb}")` and throws on unparseable input.

### 1.3 Copies, CI scope & pinned evidence

Exactly one canonical architecture document exists: this file in `sportsdesk-ops`. The dotfiles repo holds two tracked pointers that only name this file (`token_architecture_and_verification_runbook.md` and `docs/token_architecture_and_verification_runbook.md`), plus one untracked vault-style pointer (`docs/bun-color-css-houdini-at-property-architecture.md`) that states it is not tracked in git and not covered by CI. No vault copy participates in CI; none should be edited as if it were canonical. The prototype boundary and the 8-token grade palette pin are enforced by the dotfiles CI job, which runs `bun test ./tests/` (40 tests across 9 files, including `prototype_boundary.test.ts` and `prototype_grade_palette.test.ts`); this repo's CI cannot see them.

Pinned on 2026-10-28 on `bun --revision` → `1.4.4+38afee6c8`:

```console
$ bun -e 'console.log(Bun.color("#f59e0b","number"), Bun.color("#f59e0b","ansi-16m"), Bun.color("#f59e0b","hex"))'
16096779 \x1b[38;2;245;158;11m #f59e0b

$ bun -e 'console.log(typeof Bun.color("#f59e0b","number"), JSON.stringify(Bun.color("#f59e0b","[rgba]")), Bun.color("#f59e0b80","number"))'
number [245,158,11,255] 16096779

$ rg -c '@property --sd-' customer-churn-simulation-dashboard.html telegram-miniapp-dashboard.html
customer-churn-simulation-dashboard.html:18
telegram-miniapp-dashboard.html:18

$ grep -c 'token_name = ' tokens.toml
18

$ rg -n -- '--sd-tier-steam' customer-churn-simulation-dashboard.html
74:      @property --sd-tier-steam {
126:        --sd-tier-steam: #f59e0b;
137:        --sd-warning: var(--sd-tier-steam);

$ rg -c 'initial-value' *.html
customer-churn-simulation-dashboard.html:18
telegram-miniapp-dashboard.html:18

# spot check: --sd-tier-steam initial-value: #f59e0b (line 77) == :root value (line 126)

$ rg -n -- '--color-grade-' docs/prototypes/sportsdesk-surveillance-dashboard.html ~/dotfiles/docs/prototypes/sportsdesk-surveillance-dashboard.html
33:        --color-grade-aaa-rgb: 16 185 129;      /* 0x10B981 Prime Reserve [20%+) */
34:        --color-grade-aa-rgb: 5 150 105;       /* 0x059669 High Quality [12%..20%) */
35:        --color-grade-a-rgb: 6 182 212;        /* 0x06B6D4 Upper Medium [5%..12%) */
36:        --color-grade-bbb-rgb: 100 116 139;    /* 0x64748B Baseline Neutral [0%..5%) */
37:        --color-grade-bb-rgb: 245 158 11;      /* 0xF59E0B Speculative Watch [-5%..0%) */
38:        --color-grade-b-rgb: 249 115 22;       /* 0xF97316 Highly Speculative [-10%..-5%) */
39:        --color-grade-ccc-rgb: 234 88 12;      /* 0xEA580C Vulnerable Deficit [-25%..-10%) */
40:        --color-grade-d-toxic-rgb: 244 63 94;  /* 0xF43F5E Inverted / Toxic Override Rose */

$ # tokens.toml now holds 18 tokens (UI chrome added); grade mapping is unchanged: 5 mirror, 3 have no canonical token
#059669 -> (none)   #f97316 -> (none)   #ea580c -> (none)
$ rg -n 'colorHexIntToAnsiEscape|Bun\.color' sportsdesk_cli.ts scripts/generate_tokens.ts
sportsdesk_cli.ts:483:    const ansi = Bun.color(n.hex, "ansi-16m") ?? "";
sportsdesk_cli.ts:514:    const ansi = Bun.color(n.hex, "ansi-16m") ?? "";
sportsdesk_cli.ts:552:    const ansi = Bun.color(n.hex, "ansi-16m") ?? "";
```

`colorHexIntToAnsiEscape` no longer exists in the repo — the `rg` above returns only `Bun.color(hex, "ansi-16m")` call sites, so no parity test is needed.

`bun test tests/verify_tokens.test.ts` on the same build:

```console
(pass) 1. Single Source of Truth & Zero-Drift Regeneration > test_assert_zero_drift_between_tokens_toml_and_source_code
(pass) 2. Color Uniqueness & CIEDE2000 Perceptual Evaluation > test_perceptual_distance_ciede2000_pairwise_evaluation
(pass) 5. Dead-Token & Bi-Directional Reference Consistency > test_assert_every_qwen_token_is_registered_and_declared_in_root_with_matching_color
(pass) 5. Dead-Token & Bi-Directional Reference Consistency > test_assert_every_registered_sd_property_initial_value_equals_root_value
(pass) 5. Dead-Token & Bi-Directional Reference Consistency > test_assert_non_token_root_properties_are_aliases_of_tokens
(pass) 5. Dead-Token & Bi-Directional Reference Consistency > test_assert_every_referenced_sd_property_is_defined
(pass) 5. Dead-Token & Bi-Directional Reference Consistency > test_assert_no_raw_color_literals_outside_token_blocks
(pass) 5. Dead-Token & Bi-Directional Reference Consistency > test_assert_text_tokens_meet_wcag_aa_on_every_surface

 18 pass
 0 fail
 594 expect() calls
Ran 18 tests across 1 file. [36.00ms]
```

That run covers exactly the 18 `tokens.toml` tokens in both production dashboards (`customer-churn-simulation-dashboard.html`, `telegram-miniapp-dashboard.html`). `@supports` remains the place for older-browser value overrides; a `:root` block is not a value-level fallback for an invalid registered property. The interpolation claim is scoped to the style engine, not the compositor (`rg -n 'compositor'` matches only line 53's correction and this sentence).

---

## 2. Perceptual Distance & Contrast Gates

All color assignments must satisfy automated mathematical validation in `validation/token_validator.ts`:

- **CIEDE2000 Separation Floor:** $\Delta E_{00} \ge 7.0$ across all token pairs to guarantee distinct perceptual legibility on DirectColor terminals and OLED displays.
- **WCAG 2.1 Relative Luminance & Contrast Standards:**
  - **Graphical Components & Badges:** Minimum $3.0:1$ contrast against dark canvas backgrounds (`#070b14` / `#0b1120`).
  - **Body & Table Text Elements:** Minimum $4.5:1$ contrast for standard text; minimum $7.0:1$ for AAA high-legibility elements (e.g. slate-400 `#94a3b8` achieving $7.34:1$).
- **Ordered Risk Spectrum:** Palettes progressing from low to high risk must be documented as an ordered severity spectrum with documented midpoint neutrals, avoiding claims of mathematical $L^*$ or hue monotonicity unless formally verified by test.

---

## 3. Native Bun Toolchain Policy

- **Single Runtime Standard:** All repository scripts, verification gates, linters, and hooks must execute natively on Bun (`#!/usr/bin/env bun`).
- **Zero Secondary Runtimes:** No external scripting runtimes (such as Python, Ruby, or Perl) may be introduced into `package.json`, `.githooks/`, or `.github/workflows/` for repository gating.
- **Native Primitives:** Utilize native Bun APIs (`Bun.Glob`, `Bun.file()`, `Bun.escapeHTML`, `Bun.color()`, `Bun.markdown`) for high-throughput I/O and text processing.

---

## 4. Verification Gate & Denominator Standards

Every static gate and linter must adhere to strict reporting and testing standards:

- **Published Denominators:** Any gate asserting compliance (such as `check-fetch-init.ts`) must publish the complete inspection denominator in its execution log (e.g., `N files scanned, M call sites inspected across K files`). Zero violations without a declared denominator is considered unverified.
- **Planted-Violation Meta-Tests:** Every custom lint rule must be accompanied by an automated meta-test in `tests/` that plants known violations across all supported syntax forms, asserting non-zero exit codes.
- **Pollution-Free Teardown:** Meta-tests creating scratch test files must execute cleanup inside strict `try ... finally` blocks to guarantee working tree cleanliness.

---

## 5. Prototype Governance & Promotion Boundary

- **Prototype Isolation:** Experimental or unmanaged interface artifacts reside strictly under `docs/prototypes/` in the dotfiles repo (not this repo), where `tests/prototype_boundary.test.ts` enforces the boundary, and carry the mandatory file header:
  ```html
  <!-- PROTOTYPE — not in gen:tokens. Maintained as prototype reference under docs/prototypes/ -->
  ```
- **Production Promotion Gate:** A prototype may only be promoted into production webview routes when:
  1. It is registered as an output target in `scripts/generate_tokens.ts` and satisfies the `gen:tokens` zero-diff gate.
  2. All dynamic DOM injection uses safe DOM construction or verified escaping, passing `check-innerhtml.ts`.
  3. External CDNs are removed and assets are bundled locally under a strict Content Security Policy (`default-src 'self'`).
  4. Accessibility audits confirm zero critical/serious violations with full WAI-ARIA behavioral compliance.

---

## 6. Subprocess & Shell Execution Policy

Subprocess execution via `Bun.spawn` and Bun Shell (`$`) must adhere to strict concurrency, security, and lifecycle constraints:

- **Concurrent Stream Draining (Deadlock Prevention):**
  When spawning processes with `stdout: "pipe"` or `stderr: "pipe"`, never await `proc.exited` before reading the streams. Bounded OS pipe buffers (16 KB on macOS, 64 KB on Linux) cause child processes to block indefinitely on `write(2)`. Always drain streams concurrently:
  ```typescript
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    proc.stdout ? proc.stdout.text() : Promise.resolve(""),
    proc.stderr ? proc.stderr.text() : Promise.resolve(""),
  ]);
  ```
- **Deterministic Subprocess Deadlines:**
  Every subprocess invocation must provide a bounded timeout via `signal: AbortSignal.timeout(ms)` to guard against hung child processes blocking hooks or CI runners.
- **Sanitized Environment Inheritance:**
  `Bun.spawn` and `$` inherit `process.env` by default. Outbound processes and git hooks must pass sanitized `env:` mappings or explicit strips to prevent leaking sensitive API tokens (`TELEGRAM_BOT_TOKEN`, `CLOUDFLARE_API_TOKEN`, `F402_PASSWORD`) to child subprocesses.
- **Bun Shell (`$`) API Invariants:**
  - **Pipe Operators:** The pipe operator `|` belongs _inside_ the template literal string (`await $`cmd1 | cmd2`.text()`). Bun Shell's `ShellPromise` does **not** expose a `.pipe()` JavaScript method.
  - **Input Redirection & Standard Input:** Bun Shell exposes a `get stdin(): WritableStream` property on `ShellPromise`. Piping arbitrary JavaScript strings or buffers into subprocess stdin must be performed via:
    ```typescript
    // Option A: Passing Blob/Buffer directly to Bun.spawn stdin
    const proc = Bun.spawn(cmd, { stdin: new Blob([payloadString]) });

    // Option B: Using the WritableStream getter writer
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(payloadString));
    await writer.close();
    ```
    Bun Shell redirection also accepts `ReadableStream`, `Blob`, and `Response` objects as expressions (`$`cat < ${blob}``). Never pass arbitrary strings as shell file paths (`< ${fileList}`).
  - **Exit Code Handling:** In test suites, use `.nothrow()` and assert `result.exitCode`. In operational hooks, omit `.nothrow()` (or use `.throws(true)`) to fail immediately on non-zero exits.
