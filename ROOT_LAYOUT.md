# Repository layout (root)

The root holds **workspace metadata** only (`package.json`, `bun.lock`, `bunfig.toml`, `.gitattributes`, `tsconfig.json`, `.npmrc`, `.oxlintrc*.json`, `dashboard.md`, and top-level docs). Executable CLIs, scripts, and SSOT live in subdirectories (`cli/`, `scripts/`, `bin/`, `packages/sportsdesk-ops/bin/`) and link into `node_modules/.bin/` for `bun x <cli>` execution.

| Path            | Purpose                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `cli/`          | All `sportsdesk_*_cli.ts` entrypoints ([cli/README.md](cli/README.md))                                                    |
| `services/`     | Daemon, bot, R2, churn engine, ingestion ([services/README.md](services/README.md))                                       |
| `catalog/`      | Fantasy402 sport navigation catalog ([catalog/README.md](catalog/README.md))                                              |
| `design/`       | `tokens.toml` + generated `domain-branded-types.ts` ([design/README.md](design/README.md))                                |
| `lib/`          | Shared modules; token math in `lib/validation/`                                                                           |
| `schema/`       | Migrations, local manifest, schema preload ([schema/README.md](schema/README.md))                                         |
| `infra/`        | Pages `_headers` for docs deploy ([infra/README.md](infra/README.md))                                                     |
| `types/`        | Ambient `env.d.ts` ([types/README.md](types/README.md))                                                                   |
| `scripts/`      | Generators, Manager Tools fetchers, capture, audits; `scripts/deploy/` for VPS/docs                                       |
| `reports/`      | Auditable surveillance outputs, Plane 3 ingestion JSONL, and docs-review artifacts                                        |
| `static/`       | Token-compiled daemon HTML dashboards                                                                                     |
| `docs/`         | Evidence portal; `docs/runbooks/`; `docs/provenance/`                                                                     |
| `tests/`        | Bun test suites                                                                                                           |
| `client/`       | Browser-side overlay seam preload (`security-seams.preload.js`)                                                           |
| `config/`       | Wagers capture configuration (`wagers.json`, `wagers-capture.toml`)                                                       |
| `packages/`     | Workspace packages (`@sportsdesk/ops` CLI bin + token package, `@sportsdesk/nsh-desk`, `ba-example`, `@sportsdesk-ops/*`) |
| `verification/` | TLA+/gate verification specs (e.g. the gen-tokens zero-drift gate)                                                        |
| `bin/`          | Operator wrappers (`bin/dx`, `bin/wrangler`), image/XML/blob CLIs, and CI AST gates                                       |

**Harness plugins (`dsh-plugin*`).** Removable DeepSeek Harness bundles live at the root, each its own
package with a `cordis.patch.yml` manifest and a dependency-free `verify-load.mjs` smoke harness so it
can be installed, disabled, or removed independently: `dsh-plugin/` (Host tools), `dsh-plugin-ui/`
(composer desk-status row), `dsh-plugin-sidebar/` (left-sidebar SportsDesk desk page),
`dsh-plugin-security/` (read-only security/fraud console), and `dsh-plugin-watchlist-autobet/`
(paper-only watchlist autobet control plane). `tests/plugin_bundles.test.ts` enforces that every
bundle's `verify-load.mjs` passes; it does not prove a running Host UI.

**Deploy & reports**

- `bun run deploy` → `scripts/deploy/deploy_to_vps.sh`
- `bun run reports` → `scripts/deploy/run_reports.sh`
- `bun run deploy:docs` → `scripts/deploy/deploy_docs.sh`

**Workspace manifests and gates**

- `packages/sportsdesk-ops` is `@sportsdesk/ops`: `src/cli/gen-tokens.ts` compiles `design/tokens.toml` (v1.3.0) into `src/generated/domain-branded-types.ts` and `src/generated/tokens.css` (exports `./tokens`, `./tokens/css`), enforcing the contract in `src/tokens/tokens_v13.ts` and the WCAG/CIEDE2000 gate in `src/tokens/a11y_gate.ts`. `bun run --filter '@sportsdesk/ops' gen:tokens:gate` fails on drift (exit 70) or a gate violation.
- `packages/nsh-desk` is `@sportsdesk/nsh-desk` and depends on `@sportsdesk/ops` via `workspace:*`.
- Leaf `@types/bun` is pinned exactly (`1.4.4`); only the root declares `trustedDependencies` (empty).
- `bunfig.toml` keeps machine-owned install keys out (see `tests/bun_config_policy.test.ts`) and sets `exact`/`ignoreScripts`; scoped registry auth is `$ENV` only.
- `scripts/verify_ci_gates.ts` runs the rules in `scripts/bun_native_rules.ts` (lockfile, credentials, env isolation, `.gitattributes`, bunfig, manifests, DodSpine naming, loop indices, pinned oven-sh/bun links, local `.json`/`.sqlite` artifacts) and reports file paths and key names only. Ratchet baselines live in `scripts/bun_native_rules.baseline.ts`; `.npmrc` is a known waiver until it is removed.
- The 5-stage sequence and the R2 manifest promotion are in [docs/runbooks/five_stage_verification.md](docs/runbooks/five_stage_verification.md).
