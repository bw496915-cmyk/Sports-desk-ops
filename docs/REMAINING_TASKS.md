# Remaining tasks — SportsDesk ops

Read it: `bun ./docs/REMAINING_TASKS.md` (zero-code ANSI renderer, no JS VM; honours `NO_COLOR`,
`FORCE_COLOR` and `COLUMNS`).

Artifact/gate: `bun run tasks:render` (ANSI; colour and OSC 8 links only on a TTY),
`--no-color --columns 0` for logs, `--format html --out scratch/remaining-tasks.html` for HTML,
`--format iframe` for an embeddable `<iframe srcdoc>` wrapper.

### Embedding

`srcdoc` is entity-decoded once by the HTML parser before its contents are parsed. Escaping only `"`
therefore turns the `&lt;img …&gt;` that `noHtml*` emitted back into live markup; escaping `&` first keeps
one decode level in place. The renderer escapes `&` then `"`, adds `sandbox` and a `title`, and a test
asserts that one decode restores the HTML exactly and that no `<img` survives.

`[OBSERVED]` 2026-10-31, local headless Chrome on a scratch page: the `"`-only form executed
`onerror` and retitled the parent document; the `&`-first form did not. The probe was not committed.

### Renderer parity

The JS API and the `bun ./file.md` loader are both documented as Rust-based. The CLI adds global table
widths and `COLUMNS` detection, not a different parser core; still diff both after a Bun upgrade before
snapshotting either output.

`Bun.markdown.ansi()` takes an `AnsiTheme` only — `tagFilter`/`headings` belong to `html()`. It also
enables `wikiLinks`, `underline` and `latexMath` by default and offers no `Options` to disable them, so
this doc deliberately avoids wiki brackets, double underscores and dollar math (test-enforced). Per-task colouring requires `render()`,
where `listItem.checked` is `undefined` for a plain bullet, `false` for `- [ ]`, and `true` for `- [x]`.

`tagFilter` is a GFM compatibility filter, not a sanitizer: it escapes a specific tag list but leaves
event-handler attributes alone. The HTML artifact therefore also sets `noHtmlBlocks`/`noHtmlSpans`;
untrusted Markdown would still need a real sanitizer at the boundary.

Those four claims are resolved against Bun records, not memory:

- `doc:runtime/markdown` — the Markdown guide (Options table, callback metas, heading IDs).
- `api:Bun.markdown.html` — `html(input, options?: Options): string`.
- `api:Bun.markdown.ansi` — `ansi(input, theme?: AnsiTheme): string` (no `Options` parameter).
- `api:Bun.markdown.render` — `render(input, callbacks?, options?): string`.
- `api:Bun.markdown.Options` — `headings?: boolean | { autolink: boolean; ids: boolean }` (both fields
  required by the type; the guide's `{ ids: true }` example is partial) and `tagFilter?: boolean`
  described as the GFM tag filter for disallowed tags.
- `api:Bun.markdown.ListItemMeta` — the `listItem` meta, including `checked?`.

Record version: `bun-types` v1.4.3, resolved through the `bun-dev` MCP server. Record ids are cited in
the references table below and are the strings to re-resolve after a Bun upgrade.

Meta task list. Every item carries a **basis** (`[CODE]`, `[OBSERVED]`, `[UNVERIFIED]`, `[ASSUMPTION]`),
a **done when** condition you can check against an artifact, and the **blocked by** dependency.

| Label          | Meaning                                          | Can close a task?       |
| :------------- | :----------------------------------------------- | :---------------------- |
| `[CODE]`       | Reproducible from this repository                | Yes                     |
| `[OBSERVED]`   | A capture/artifact with a date and path          | Yes                     |
| `[UNVERIFIED]` | External-system behaviour inferred, not captured | No — needs a capture    |
| `[ASSUMPTION]` | A modelling choice about data                    | No — needs confirmation |

### Reference IDs

Each task carries a stable `Ref:` id. The id does not change when tasks are renumbered or reordered;
the table resolves it to the record that justifies the basis and to the artifact that closes it. A ref
id that appears on a task but not in this table is a defect, and a test enforces it.

| Ref                    | Task     | Basis record                                     | Closes against    |
| :--------------------- | :------- | :----------------------------------------------- | :---------------- |
| `RT-F402-CAPTURE`      | P0.1     | `[UNVERIFIED]` combo_identity.ts:24              | ledger row        |
| `RT-PREFEE-PNL`        | P0.2     | `[UNVERIFIED]` third-party toolkit               | one wallet        |
| `RT-AUTH-HEADER`       | P0.3     | `[OBSERVED]` HAR 2026-10-28                      | header capture    |
| `RT-STALE-TAG`         | P0.4     | `[OBSERVED]` docs-v2026.10.31                    | tag list          |
| `RT-CI-BACKTEST`       | P1.1     | `[CODE]` parlay_combo_backtest_engine.test.ts:41 | CI fixture        |
| `RT-CHANNEL-MODEL`     | P1.2     | `[CODE]` tokens.toml lanes                       | writer capture    |
| `RT-DUP-WAGERS`        | P1.3     | `[CODE]` audit_customer_book.ts                  | audit output      |
| `RT-CAPTURE-MANIFEST`  | P1.4     | `[CODE]` capture/recorder.ts:345                 | manifest counts   |
| `RT-ATTRIBUTION-TYPES` | P1.5     | `[CODE]` customer_poly_bridge.ts:663             | bridge artifact   |
| `RT-GSLIVE-LINKS`      | P1.6     | `[OBSERVED]` three GSLive surfaces               | three captures    |
| `RT-CLI-ZIP`           | P2.1     | `[OBSERVED]` gs-manager-cli.zip                  | provenance note   |
| `RT-STALE-PLAN`        | P2.2     | `[CODE]` PLAN-full-coverage.md:134               | plan updated      |
| `RT-ARTIFACT-CADENCE`  | P2.3     | `[CODE]` package.json:76                         | cadence + check   |
| `RT-RENDER-HTML`       | Renderer | `[OBSERVED]` MCP api:Bun.markdown.html           | HTML artifact     |
| `RT-RENDER-ANSI`       | Renderer | `[OBSERVED]` MCP api:Bun.markdown.ansi           | CLI/JS diff       |
| `RT-RENDER-LISTITEM`   | Renderer | `[OBSERVED]` MCP api:Bun.markdown.render         | checked semantics |
| `RT-RENDER-SECURITY`   | Renderer | `[OBSERVED]` MCP api:Bun.markdown.Options        | tagFilter tests   |

Full paths and line numbers stay on each task's **Basis** line; this table is the ref-to-record index,
so an id resolves without guessing which artifact it came from.

## P0 — trust blockers

- [ ] **P0.1 Capture the seven F402 report endpoints**
  - **Ref:** `RT-F402-CAPTURE`
  - **Basis:** `[UNVERIFIED]` names from `lib/combo_identity.ts:24-40`; `[CODE]` tier-C rows in the spec.
  - **Done when:** each of `Pending`, `PendingDelete`, `getDailyFiguresByCustomer`, `getGradedWagerByCustomer`,
    `getTransactions`, `getGrading`, `getTicketDetailPrint` has a 2xx request **and** response capture, and
    `apply_captures` upgrades its ledger row.
  - **Blocked by:** an authenticated Manager session and a safe test account.

- [ ] **P0.2 Verify the pre-fee PnL claim**
  - **Ref:** `RT-PREFEE-PNL`
  - **Basis:** `[UNVERIFIED]` — inferred from a third-party toolkit and the `usdcSize − size × price` residual.
  - **Done when:** on one taker-heavy wallet, the residual reconciles to the gap between the official PnL and a
    cashflow replay, with the capture path recorded.
  - **Blocked by:** activity rows that carry `size` and `price` for every fill.

- [ ] **P0.3 Resolve the Authorization-header contradiction**
  - **Ref:** `RT-AUTH-HEADER`
  - **Basis:** `[OBSERVED]` 2026-10-28 HAR sent none; `[OBSERVED]` 2026-10-31 captures record a redacted
    `authorization` key; `[UNVERIFIED]` whether a bearer token is sent.
  - **Done when:** an unredacted (or explicitly absent) header capture settles it, and `fantasy402Cookie` /
    `daemonBearer` descriptions cite that capture.
  - **Blocked by:** a capture environment that keeps the header value without redaction.

- [ ] **P0.4 Retire the stale `docs-v2026.10.31` tag**
  - **Ref:** `RT-STALE-TAG`
  - **Basis:** `[OBSERVED]` the tag still cites `scripts/append_tracked_domains.mjs`, which no longer exists.
  - **Done when:** consumers point at `docs-v2026.11.01` and the old tag is either deleted or annotated as
    superseded and non-deployable.
  - **Blocked by:** nothing technical; needs a decision on tag deletion.

## P1 — coverage and data quality

- [ ] **P1.1 Make the backtest freshness test run in CI**
  - **Ref:** `RT-CI-BACKTEST`
  - **Basis:** `[CODE]` the test is guarded by `existsSync("enriched_customers_full.json")`; CI has no book.
  - **Done when:** a committed slim fixture drives the engine, and CI asserts the committed artifact matches it.
  - **Blocked by:** a fixture that does not expose customer data.

- [ ] **P1.2 Reconcile the channel model**
  - **Ref:** `RT-CHANNEL-MODEL`
  - **Basis:** `[CODE]` 7 lane codes in `tokens.toml`, 6 writer labels in the simulation union, `WEB`/`PHONE` only
    in fixtures, `GATEWAY` in neither writer union.
  - **Done when:** a `getGrading`/`getPending` capture lists distinct `TicketWriter` values, and either the union
    is extended or an explicit mapping is published.
  - **Blocked by:** P0.1 (report capture).

- [ ] **P1.3 Decide the duplicate wager numbers**
  - **Ref:** `RT-DUP-WAGERS`
  - **Basis:** `[CODE]` 48 warning rows across 44 distinct numbers in the demo book.
  - **Done when:** the numbering scope is documented (per agent vs per book) and the audit treats collisions
    accordingly, or the generator is fixed.
  - **Blocked by:** an F402 numbering reference.

- [ ] **P1.4 Separate response accounting in the capture manifest**
  - **Ref:** `RT-CAPTURE-MANIFEST`
  - **Basis:** `[CODE]` `counts.withResponse` includes HTTP 500/empty responses; the strict view lives only in
    `applied-*.json`.
  - **Done when:** the recorder emits `withSuccessResponse` / `withErrorResponse` / `emptyResponse`, with tests.
  - **Blocked by:** nothing.

- [ ] **P1.5 Clarify `coverage.attributionTypes`**
  - **Ref:** `RT-ATTRIBUTION-TYPES`
  - **Basis:** `[CODE]` it sums to 26 link rows while `coverage.wallets` is 22.
  - **Done when:** the field is renamed or documented as link counts beside the wallet count.
  - **Blocked by:** nothing.

- [ ] **P1.6 Capture GSLive deep-link behaviour**
  - **Ref:** `RT-GSLIVE-LINKS`
  - **Basis:** `[OBSERVED]` the three surfaces exist; `[UNVERIFIED]` window/bot parameters beyond the captured
    examples.
  - **Done when:** each surface has one capture-backed example and the docs say `[OBSERVED]`.
  - **Blocked by:** a GSLive session.

## P2 — hygiene

- [ ] **P2.1 Resolve the untracked `gs-manager-cli.zip`**
  - **Ref:** `RT-CLI-ZIP`
  - **Basis:** `[OBSERVED]` 31 KB archive, no provenance or license trail.
  - **Done when:** it is either documented and committed with provenance, or deleted.
  - **Blocked by:** the owner’s decision.

- [ ] **P2.2 Update or delete `reports/docs-review/PLAN-full-coverage.md`**
  - **Ref:** `RT-STALE-PLAN`
  - **Basis:** `[CODE]` untracked plan still names the removed `append_tracked_domains.mjs`.
  - **Done when:** the plan is updated or removed before it is ever committed.
  - **Blocked by:** nothing.

- [ ] **P2.3 Schedule artifact regeneration**
  - **Ref:** `RT-ARTIFACT-CADENCE`
  - **Basis:** `[CODE]` `docs/combo-uniqueness.json` and `docs/cross-domain-bridge.json` only change when
    `artifacts:value` is run manually.
  - **Done when:** a documented cadence (or cron job) regenerates and deploys them, with a freshness check.
  - **Blocked by:** a host for the scheduled run.

## Done (for context)

- [x] `[CODE]` Claim labels and citation tests (`[CODE]` / `[OBSERVED]` / `[UNVERIFIED]` / `[ASSUMPTION]`).
- [x] `[CODE]` Seven F402 report endpoints published as tier-C candidates.
- [x] `[CODE]` TypeScript pinned to 5.9.3 for `bunx tsc`.
- [x] `[OBSERVED]` `docs-v2026.11.01` tagged and deployed; 47-path spec live.
