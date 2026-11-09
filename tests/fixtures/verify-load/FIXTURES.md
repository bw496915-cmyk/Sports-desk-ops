# verify-load pinned artifacts (CI)

Tracked tree mirrored at the repository root when
`VERIFY_LOAD_FIXTURES=tests/fixtures/verify-load` (see `dsh-plugin/verify-load.mjs`).

CI proves the **shape contract**: tools import, register, and answer against these
inputs. Local `bun dsh-plugin/verify-load.mjs` without the env var still exercises
the operator book and gitignored `dist/*` / `data/*` when present.
