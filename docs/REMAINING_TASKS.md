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

### Docs pipeline

`bun run docs:render` renders every `docs/**/*.md` to a content-addressed cache and writes
`manifest.json`; `bun run docs:serve` serves that cache with zstd negotiation. The manifest `buildId`
is a hash of the entries, so an unchanged tree rebuilds byte-identically and a changed tree gets a
new id.

`Bun.zstdCompress` returns `Promise<Buffer>`, and `Bun.write(path, promise)` stores the string
`[object Promise]`: the write succeeds, `.byteLength` is `undefined`, and the `.zst` only fails later
with `ERR_ZSTD`. The builder uses `Bun.zstdCompressSync` and writes through a temp file plus rename,
so a crash cannot leave a truncated entry that the next run trusts.

### Renderer parity

The JS API and the `bun ./file.md` loader are both documented as Rust-based. The CLI adds global table
widths and `COLUMNS` detection, not a different parser core; still diff both after a Bun upgrade before
snapshotting either output.

`Bun.markdown.ansi()` takes an `AnsiTheme` only — `tagFilter`/`headings` belong to `html()`. The 1.4.3
guide says it enables `wikiLinks`, `underline` and `latexMath` by default; measured on 1.4.4, `ansi()`
leaves wiki brackets, double underscores and dollar math literal, and only `html({ wikiLinks: true })`
changes output to an `x-wikilink` element. `underline` and `latexMath` had no effect on these inputs
either way. This doc still avoids all three (test-enforced) so the artifact cannot opt into a link the
terminal view does not render. Per-task colouring requires `render()`, where `listItem.checked` is `undefined` for a plain
bullet, `false` for `- [ ]`, and `true` for `- [x]`.

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

| Ref                   | Task     | Basis record                              | Closes against    |
| :-------------------- | :------- | :---------------------------------------- | :---------------- |
| `RT-F402-CAPTURE`     | P0.1     | `[UNVERIFIED]` combo_identity.ts:24       | ledger row        |
| `RT-PREFEE-PNL`       | P0.2     | `[UNVERIFIED]` third-party toolkit        | one wallet        |
| `RT-GSLIVE-LINKS`     | P1.6     | `[OBSERVED]` three GSLive surfaces        | three captures    |
| `RT-CLI-ZIP`          | P2.1     | `[OBSERVED]` gs-manager-cli.zip           | provenance note   |
| `RT-ARTIFACT-CADENCE` | P2.3     | `[CODE]` package.json:76                  | cadence + check   |
| `RT-RENDER-HTML`      | Renderer | `[OBSERVED]` MCP api:Bun.markdown.html    | HTML artifact     |
| `RT-RENDER-ANSI`      | Renderer | `[OBSERVED]` MCP api:Bun.markdown.ansi    | CLI/JS diff       |
| `RT-RENDER-LISTITEM`  | Renderer | `[OBSERVED]` MCP api:Bun.markdown.render  | checked semantics |
| `RT-RENDER-SECURITY`  | Renderer | `[OBSERVED]` MCP api:Bun.markdown.Options | tagFilter tests   |
| `RT-DOCS-MANIFEST`    | Pipeline | `[CODE]` lib/docs_render_cache.ts         | stable buildId    |
| `RT-DOCS-SERVE`       | Pipeline | `[CODE]` lib/docs_server.ts               | q-value + range   |

Full paths and line numbers stay on each task's **Basis** line; this table is the ref-to-record index,
so an id resolves without guessing which artifact it came from.

## P0 — trust blockers

- [ ] **P0.1 Capture the seven F402 report endpoints**
  - **Ref:** `RT-F402-CAPTURE`
  - **Basis:** `[UNVERIFIED]` names from `lib/combo_identity.ts:24-40`; `[CODE]` tier-C rows in the spec.
  - **Done when:** each of `Pending`, `PendingDelete`, `getDailyFiguresByCustomer`, `getGradedWagerByCustomer`,
    `getTransactions`, `getGrading`, `getTicketDetailPrint` has a 2xx request **and** response capture, and
    `apply_captures` upgrades its ledger row.
  - **Blocked by:** a valid customerID from the agent's downline — the session's own id is rejected with
    "Invalid CustomerID" — plus each report's date filter. `bun run customers` indexes the local cohorts
    (artifact 49, demo-book 220, fixture 6) for lookup, but those are demo ids and the live endpoints
    reject them; a `capture` source appears only when a capture keeps a real id.
  - **Observed 2026-11-01** (`[OBSERVED]`, `scratch/f402-probes/`): the portal's own client at
    `/app/customer/report/report.js` builds every report from `customerID`, `token` (empty in the browser
    session; the edge accepts the bearer instead) and `operation`, plus `week` for the daily-figures and
    graded-wager reports, `date` (MM/DD/YYYY) for transactions, and `agentID` for daily figures. With that
    envelope `Pending` answers **200 with 41 KB**, `getTransactions` **200 `{"LIST":[]}`** and `getGrading`
    **200 `{"LIST":[]}`**. `getDailyFiguresByCustomer` and `getGradedWagerByCustomer` still answer 500 on
    the `week` value, and `getTicketDetailPrint` needs a ticket/wager number.
  - **Privacy:** the `Pending` payload includes customer names and a `Password` field, so probe records
    keep only a 2 KB preview under `scratch/` and nothing is promoted to `docs/`.
  - **Safety:** `PendingDelete` is named like a mutation. The capture allowlist refuses mutation ops by
    construction, so that endpoint needs an explicit read-only confirmation before it is added.
  - **Automation:** `bun run capture:f402 --dry-run` prints the six-op plan without launching anything.
    With `F402_AGENT_ID` / `F402_PASSWORD` in the environment, `--login` signs in unattended (defaults:
    `input[name="customerID"]`, `input[type="password"]`, `button.btn.btn-primary`, overridable with
    `F402_LOGIN_*`); no credential is printed or written. Credentials may live in `.env` or in the OS
    credential store (`bun run secrets:f402 set|status|delete`), and env wins when both exist. Otherwise it waits for an interactive sign-in or
    a `--wait-for` selector. Probes run from inside the page so the HttpOnly session cookie applies, and
    results land in `scratch/f402-probes/<stamp>/<op>.json` with the body that was sent, the auth mode, and
    `headersObserved: false`. `PendingDelete` is excluded unless
    `--include-unconfirmed --i-understand-mutations` is passed.

- [ ] **P0.2 Verify the pre-fee PnL claim**
  - **Ref:** `RT-PREFEE-PNL`
  - **Basis:** `[UNVERIFIED]` — inferred from a third-party toolkit and the `usdcSize − size × price` residual.
  - **Done when:** on one taker-heavy wallet, the residual reconciles to the gap between the official PnL and a
    cashflow replay, with the capture path recorded.
  - **Blocked by:** activity rows that carry `size` and `price` for every fill.

## P1 — coverage and data quality

- [ ] **P1.6 Capture GSLive deep-link behaviour**
  - **Ref:** `RT-GSLIVE-LINKS`
  - **Basis:** `[OBSERVED]` the three surfaces exist; `[UNVERIFIED]` window/bot parameters beyond the captured
    examples.
  - **Done when:** each surface has one capture-backed example and the docs say `[OBSERVED]`.
  - **Blocked by:** a GSLive session.

## P2 — hygiene

- [ ] **P2.1 Resolve the untracked `gs-manager-cli.zip`**
  - **Ref:** `RT-CLI-ZIP`
  - **Basis:** `[OBSERVED]` 31 KB, 18 files, `package.json` says `gs-manager-cli 0.2.0`, `"private": true`,
    and declares **no licence**; README describes a dependency-free Bun CLI whose live acquisition is
    deliberately blocked. The contents are self-describing enough for a checksum sidecar, but not for a
    redistribution grant.
  - **Done when:** it is either documented and committed with provenance, or deleted.
  - **Guard:** `bun run audit:archives` fails on any tracked archive without a matching
    `provenance/<name>.json` (checksum, origin, licence), so it cannot be committed by accident.
  - **Blocked by:** a licence statement (or a delete). With `private: true` and no licence file, committing
    it would assert a redistribution right nobody has recorded.

- [ ] **P2.3 Schedule artifact regeneration**
  - **Ref:** `RT-ARTIFACT-CADENCE`
  - **Basis:** `[CODE]` `docs/combo-uniqueness.json` and `docs/cross-domain-bridge.json` only change when
    `artifacts:value` is run manually. `[CODE]` `--offline` now reproduces the combo half from the cached
    CFB event index, but the bridge half still needs `scratch/bridge-live-all.json` or the demo book, so a
    clean CI checkout cannot regenerate either artifact.
  - **Done when:** a documented cadence (or cron job) regenerates and deploys them, with a freshness check.
  - **Cadence in place:** the daily `schedule:` run in `.github/workflows/ci.yml` re-checks
    `artifacts:lock` and `audit:ops`, so drift surfaces within a day even when nothing is pushed.
    `bun run artifacts:cron` is the host that can actually rebuild: an in-process `Bun.cron` job runs
    `artifacts:value` (`--offline` by default) then refreshes the lock, and journals each run to
    `scratch/artifacts-cron.jsonl` (`--history` reads it with `Bun.JSONL`). Deployment stays manual.
  - **Guard:** `bun run artifacts:lock` fails when an artifact or one of its generator inputs changed
    since `docs/artifacts.lock.json` was written. It proves nothing changed since the lock, not that the
    lock was taken right after a regeneration — so pair `artifacts:value` with `artifacts:lock --update`.
  - **Blocked by:** regeneration itself needs live inputs (the Gamma fetch and the bridge capture), which a
    clean CI checkout does not have; the schedule can detect drift but not rebuild.

## Done (for context)

- [x] `[OBSERVED]` Channel model: 955 live `getBetTicker` rows carry `TicketWriter` = Internet, ALERT,
      GSLIVE, GSBUILDER, plus one dirty `WILBANKS.` value that is an agent login. `GATEWAY`, `BLOCKED` and
      `CSLEVEL2` never appear, so the lane table describes configuration, not observed traffic.
- [x] `[OBSERVED]` Wager numbers: 0 duplicates across 955 live rows; the 48 collisions are confined to
      the demo generator, and the audit keeps warning on fixtures rather than on live data.
- [x] `[OBSERVED]` Manager auth is `Authorization: Bearer <sessionStorage.credentials.code>`; without it
      openresty answers 401. The `fantasy402Cookie` security scheme now says so.
- [x] `[CODE]` Claim labels and citation tests (`[CODE]` / `[OBSERVED]` / `[UNVERIFIED]` / `[ASSUMPTION]`).
- [x] `[CODE]` Seven F402 report endpoints published as tier-C candidates.
- [x] `[CODE]` TypeScript pinned to 5.9.3 for `bunx tsc`.
- [x] `[CODE]` Stale docs tags are registered as superseded and non-deployable: `docs/releases.json`,
      enforced by `bun run audit:release`.
- [x] `[CODE]` Capture manifest splits response accounting: `withSuccessResponse`, `withErrorResponse`,
      `emptyResponse` beside the legacy `withResponse`; validity invariants enforced on read.
- [x] `[CODE]` `coverage.attributionLinkRows` and `attributionLinks` separate link counts from `wallets`;
      `attributionTypes` kept as a deprecated alias.
- [x] `[CODE]` `reports/docs-review/PLAN-full-coverage.md` reconciled in place: stale `append_tracked_domains.mjs`
      references annotated, disproved deploy-target claim closed, status block added.
- [x] `[CODE]` Backtest engine runs in CI from a committed synthetic fixture
      (`tests/fixtures/backtest/`); file-independent sections are pinned against
      `docs/backtest-4wk-cfb-nba.json`.
- [x] `[OBSERVED]` `docs-v2026.11.01` tagged and deployed; 47-path spec live.
