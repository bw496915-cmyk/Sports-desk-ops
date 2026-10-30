# SportsDesk ops docs

Evidence-labelled API documentation for the SportsDesk & Fantasy402 wire surface. The portal is
**Scalar**, pinned to a single CDN version with SRI; the markdown reference is **generated** from the
OpenAPI spec plus the evidence ledger, so a claim cannot drift away from its evidence tier.

## What is verified vs inferred

- **Verified (tier B):** a small number of operations have a captured request or an
  implementation-verified route. The only real wire capture is the 2026-10-28 Manager HAR
  (portal `v1.0.279`, request side only).
- **Inferred (tier C):** most operations are authored proposals — no request or response was ever
  observed, and their request/response shapes are not contracts.
- **Captured responses (tier A):** none yet. The live capture tooling is available but has not been run
  for this release, so **every response schema in these docs is authored unless its row says otherwise**.
  GS Partner 118 live acquisition is `blocked_contract` by design.

Read the full model in [EVIDENCE.md](./EVIDENCE.md). The machine-readable source of truth is
[evidence/ledger.json](./evidence/ledger.json); the capture plan is
[evidence/capture-requests.md](./evidence/capture-requests.md); the missing-surface inventory is
[evidence/surfaces.md](./evidence/surfaces.md); the capture/apply tooling is
[evidence/capture-tooling.md](./evidence/capture-tooling.md).

## Docs set

| Doc                                                                            | Audience           | Contents                                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| [api-reference.md](./api-reference.md)                                         | Developers & Risk  | Generated reference: evidence tiers, headers matrix, auth, per-operation sections, inferred/missing-surface appendices           |
| [openapi.json](./openapi.json)                                                 | API / OpenAPI 3.1  | Machine-readable spec (`info.version` 2026.10.31) with per-operation `x-evidence`                                                |
| [index.html](./index.html)                                                     | Interactive portal | Scalar viewer (`@scalar/api-reference@1.76.4`, SRI-pinned), dark theme                                                           |
| [EVIDENCE.md](./EVIDENCE.md)                                                   | Auditors           | Evidence standard, tier legend, what is verified vs inferred, contradictions, limitations                                        |
| [gs-manager-contracts.md](./gs-manager-contracts.md)                           | GS integration     | Why the GS manager CLI has **no** HTTP contract: 6 report kinds, all `blocked_contract`, the one observed `getBetReport` payload |
| [evidence/capture-tooling.md](./evidence/capture-tooling.md)                   | Capture operators  | WebView+FetchSession architecture, capture store schema v1, live gating, read-only allowlist, redaction, B→A upgrade rules       |
| [schema-dump-operations.md](./schema-dump-operations.md)                       | Registry + release | `dump-prod` vs `sync-prod-dump`, snapshot parity, allowlist, `captured_at` / dump lag                                            |
| [schema-sqlite-failure-mode-matrix.md](./schema-sqlite-failure-mode-matrix.md) | Debug parity exits | Exit **2** / **3**, env knobs, SQLite strict/sentinel, EOD WAL                                                                   |

## Regenerating and gating the docs

```bash
bun run scripts/generate_docs.ts          # writes docs/api-reference.md (deterministic)
bun run scripts/generate_docs.ts --out /tmp/api-reference.md
bun run test:docs                         # docs invariants (spec, ledger, markdown, portal, headers)
bun run verify:docs                       # structural gate + markdown freshness + staging parity
```

`docs/api-reference.md` is generated, not edited by hand. If you change [openapi.json](./openapi.json)
or [evidence/ledger.json](./evidence/ledger.json), re-run the generator and commit the result.

## Capturing and applying evidence

```bash
bun run capture:evidence                  # mock/offline capture run (CI-safe, never upgrades evidence)
F402_LIVE_CAPTURE=1 bun run capture:evidence:live   # gated live run; credentials in .env, never argv
bun run apply:captures                    # dry-run: validate the store and print the B->A plan
bun run apply:captures -- --write         # apply, regenerate spec+markdown, run the docs gate, audit
bun run docs:audit:portal                 # one console/DOM audit of the deployed docs portal
bun run crawl:tiles                       # offline launcher-tile discovery (candidates, no wire claims)
```

Tier A stays 0 until a live capture actually lands; `apply_captures` refuses mock captures, requires a
clean-redaction live 2xx response with a body skeleton, resolves a contradicted row only through such a
capture (recording the previous reason), and is idempotent. `--write` is capture-ready: it upgrades B→A
from live captures, regenerates the spec and markdown, and the docs gate accepts a valid `x-capture` (see
[evidence/capture-tooling.md](./evidence/capture-tooling.md)).

**Portal deploy staging:** `bun run docs:stage` copies `docs/index.html`, `docs/openapi.json` and
`functions/_headers` into `dist/`; Cloudflare Pages only applies `_headers` when it is at the deploy
root. Do not unpin the Scalar version or remove the `integrity`/`crossorigin` attributes.

**CLI entry:** `bun run sportsdesk_schema_cli.ts --help` · `bun sportsdesk_cli.ts forensics --help`

**CI:** `bun run schema:gate` — typecheck, snapshot parity (`CI=true`), fixture drift check, parity gauntlet, EOD smoke.

**Drills:** `schema:parity-gauntlet` · `schema:check-fixture-drift` · `eod:smoke`

**Diagram:** [assets/ARCH-Guide.png](./assets/ARCH-Guide.png)
