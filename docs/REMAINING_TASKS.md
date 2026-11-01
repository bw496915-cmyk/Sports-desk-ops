# Remaining tasks — SportsDesk ops

Read it: `bun ./docs/REMAINING_TASKS.md` (zero-code ANSI renderer, no JS VM; honours `NO_COLOR`,
`FORCE_COLOR` and `COLUMNS`).

Artifact/gate: `bun run tasks:render` (ANSI; colour and OSC 8 links only on a TTY),
`--no-color --columns 0` for logs, `--format html --out scratch/remaining-tasks.html` for HTML.

### Renderer parity

`bun ./docs/REMAINING_TASKS.md` is the CLI `.md` loader (Rust/pulldown-cmark) and is **not** the same
renderer as `Bun.markdown.ansi()` (JS). The CLI adds syntax highlighting and global table widths; do not
assume byte-identical output. Pin Bun (1.4.4) and diff both after upgrades if you snapshot either output.

`Bun.markdown.ansi()` takes an `AnsiTheme` only — `tagFilter`/`headings` belong to `html()`. Per-task
colouring requires `render()`, where `listItem.checked` is `undefined` for a plain bullet, `false` for
`- [ ]`, and `true` for `- [x]`.

Meta task list. Every item carries a **basis** (`[CODE]`, `[OBSERVED]`, `[UNVERIFIED]`, `[ASSUMPTION]`),
a **done when** condition you can check against an artifact, and the **blocked by** dependency.

| Label          | Meaning                                          | Can close a task?       |
| :------------- | :----------------------------------------------- | :---------------------- |
| `[CODE]`       | Reproducible from this repository                | Yes                     |
| `[OBSERVED]`   | A capture/artifact with a date and path          | Yes                     |
| `[UNVERIFIED]` | External-system behaviour inferred, not captured | No — needs a capture    |
| `[ASSUMPTION]` | A modelling choice about data                    | No — needs confirmation |

## P0 — trust blockers

- [ ] **P0.1 Capture the seven F402 report endpoints**
  - **Basis:** `[UNVERIFIED]` names from `lib/combo_identity.ts:24-40`; `[CODE]` tier-C rows in the spec.
  - **Done when:** each of `Pending`, `PendingDelete`, `getDailyFiguresByCustomer`, `getGradedWagerByCustomer`,
    `getTransactions`, `getGrading`, `getTicketDetailPrint` has a 2xx request **and** response capture, and
    `apply_captures` upgrades its ledger row.
  - **Blocked by:** an authenticated Manager session and a safe test account.

- [ ] **P0.2 Verify the pre-fee PnL claim**
  - **Basis:** `[UNVERIFIED]` — inferred from a third-party toolkit and the `usdcSize − size × price` residual.
  - **Done when:** on one taker-heavy wallet, the residual reconciles to the gap between the official PnL and a
    cashflow replay, with the capture path recorded.
  - **Blocked by:** activity rows that carry `size` and `price` for every fill.

- [ ] **P0.3 Resolve the Authorization-header contradiction**
  - **Basis:** `[OBSERVED]` 2026-10-28 HAR sent none; `[OBSERVED]` 2026-10-31 captures record a redacted
    `authorization` key; `[UNVERIFIED]` whether a bearer token is sent.
  - **Done when:** an unredacted (or explicitly absent) header capture settles it, and `fantasy402Cookie` /
    `daemonBearer` descriptions cite that capture.
  - **Blocked by:** a capture environment that keeps the header value without redaction.

- [ ] **P0.4 Retire the stale `docs-v2026.10.31` tag**
  - **Basis:** `[OBSERVED]` the tag still cites `scripts/append_tracked_domains.mjs`, which no longer exists.
  - **Done when:** consumers point at `docs-v2026.11.01` and the old tag is either deleted or annotated as
    superseded and non-deployable.
  - **Blocked by:** nothing technical; needs a decision on tag deletion.

## P1 — coverage and data quality

- [ ] **P1.1 Make the backtest freshness test run in CI**
  - **Basis:** `[CODE]` the test is guarded by `existsSync("enriched_customers_full.json")`; CI has no book.
  - **Done when:** a committed slim fixture drives the engine, and CI asserts the committed artifact matches it.
  - **Blocked by:** a fixture that does not expose customer data.

- [ ] **P1.2 Reconcile the channel model**
  - **Basis:** `[CODE]` 7 lane codes in `tokens.toml`, 6 writer labels in the simulation union, `WEB`/`PHONE` only
    in fixtures, `GATEWAY` in neither writer union.
  - **Done when:** a `getGrading`/`getPending` capture lists distinct `TicketWriter` values, and either the union
    is extended or an explicit mapping is published.
  - **Blocked by:** P0.1 (report capture).

- [ ] **P1.3 Decide the duplicate wager numbers**
  - **Basis:** `[CODE]` 48 warning rows across 44 distinct numbers in the demo book.
  - **Done when:** the numbering scope is documented (per agent vs per book) and the audit treats collisions
    accordingly, or the generator is fixed.
  - **Blocked by:** an F402 numbering reference.

- [ ] **P1.4 Separate response accounting in the capture manifest**
  - **Basis:** `[CODE]` `counts.withResponse` includes HTTP 500/empty responses; the strict view lives only in
    `applied-*.json`.
  - **Done when:** the recorder emits `withSuccessResponse` / `withErrorResponse` / `emptyResponse`, with tests.
  - **Blocked by:** nothing.

- [ ] **P1.5 Clarify `coverage.attributionTypes`**
  - **Basis:** `[CODE]` it sums to 26 link rows while `coverage.wallets` is 22.
  - **Done when:** the field is renamed or documented as link counts beside the wallet count.
  - **Blocked by:** nothing.

- [ ] **P1.6 Capture GSLive deep-link behaviour**
  - **Basis:** `[OBSERVED]` the three surfaces exist; `[UNVERIFIED]` window/bot parameters beyond the captured
    examples.
  - **Done when:** each surface has one capture-backed example and the docs say `[OBSERVED]`.
  - **Blocked by:** a GSLive session.

## P2 — hygiene

- [ ] **P2.1 Resolve the untracked `gs-manager-cli.zip`**
  - **Basis:** `[OBSERVED]` 31 KB archive, no provenance or license trail.
  - **Done when:** it is either documented and committed with provenance, or deleted.
  - **Blocked by:** the owner’s decision.

- [ ] **P2.2 Update or delete `reports/docs-review/PLAN-full-coverage.md`**
  - **Basis:** `[CODE]` untracked plan still names the removed `append_tracked_domains.mjs`.
  - **Done when:** the plan is updated or removed before it is ever committed.
  - **Blocked by:** nothing.

- [ ] **P2.3 Schedule artifact regeneration**
  - **Basis:** `[CODE]` `docs/combo-uniqueness.json` and `docs/cross-domain-bridge.json` only change when
    `artifacts:value` is run manually.
  - **Done when:** a documented cadence (or cron job) regenerates and deploys them, with a freshness check.
  - **Blocked by:** a host for the scheduled run.

## Done (for context)

- [x] `[CODE]` Claim labels and citation tests (`[CODE]` / `[OBSERVED]` / `[UNVERIFIED]` / `[ASSUMPTION]`).
- [x] `[CODE]` Seven F402 report endpoints published as tier-C candidates.
- [x] `[CODE]` TypeScript pinned to 5.9.3 for `bunx tsc`.
- [x] `[OBSERVED]` `docs-v2026.11.01` tagged and deployed; 47-path spec live.
