# Code Mode profile-tool suite

Frozen-oracle, property-based, guest-boundary and mutation tests for
`lib/profile_query_tools.ts` (the `query_profiles` / `get_profile` / `get_profile_summary`
Code Mode tools).

## The oracle is frozen

[tests/code_mode/oracle.ts](oracle.ts) is the specification. It is derived from the committed
31-profile snapshot ([data/profile-snapshot.json](../../data/profile-snapshot.json)) and the
schema constants (`MAX_LIMIT = 500`, fields `clv` | `vol` | `sharp`), **not** from the
implementation. It throws at import when the profile count or sentinel ids drift.

To re-freeze deliberately after a contract change:

1. `bun run scripts/generate_profile_snapshot.ts` (rebuilds the snapshot from the operator book;
   `data/customer-profiles.json` is gitignored and absent in CI). `bun run
check:profile-snapshot` fails when the committed artifact no longer matches the book.
2. Update `EXPECTED_PROFILE_COUNT` / `EXPECTED_SENTINEL_IDS` in `oracle.ts` if they moved.
3. Run `bun run check:oracle-frozen` — a snapshot or argument-schema change without an oracle
   change fails the gate.

## Properties

Besides exact comparison with the reference query for arbitrary arguments, the suite asserts
metamorphic properties that hold independently of the oracle:

- a smaller `limit` is an exact prefix of a larger one, and `truncated` tracks `limit > MAX_LIMIT`;
- default rows are the sentinel-free subsequence of `includeSentinels: true` rows;
- repeated calls are deterministic and every row's `flags` equal `get_profile(row.id).flags`;
- `includeSentinels` is strict identity, so truthy non-booleans never opt in;
- sentinel state is the profile id (`SYNTH_*`), not the sort value — a real profile carrying the
  old sentinel numbers is not a sentinel row.

The pure core `querySnapshot(snapshot, args)` is tested over **generated snapshots** (0–40 rows,
duplicate values, ties, negatives, synthetic ids), against a separately written reference model —
so ordering, filtering, limits and freezing are exercised beyond the frozen 31 rows. A second
suite runs the same requests through **SQLite** (`ORDER BY value DESC, id ASC LIMIT ?`) and requires
both engines to agree row-for-row. The freeze gate itself is tested by spawning it against a
throwaway git repository: clean, schema-only, and paired-change cases.

## Gates

```sh
bun run ci:code-mode          # sequential: drift -> freeze -> tests -> mutation -> guest probe
bun run test:code-mode        # property/unit/parser/guest tests only
bun run mutation:code-mode    # Stryker, thresholds high 80 / low 60 / break 60
bun run probe:code-mode       # QuickJS guest probe as a standalone gate
bun run check:profile-snapshot
```

Property runs default to 100 cases; override with `FAST_CHECK_NUM_RUNS` and pin a failing run
with `FAST_CHECK_SEED`.

Mutation runs in place (the sandbox cannot resolve Stryker's TypeScript preprocessor under this
repo's isolated linker), and the gate script restores the executable bits and symlinks that
in-place restore strips. The HTML report is written to `reports/mutation/mutation.html`
(force-added; `reports/` is gitignored).

## Sandbox boundary

`lib/quickjs_code_mode.ts` runs cells in a QuickJS WASM realm whose only host capability is a
`tools` bridge. Cells may `await` (host promises are settled by pumping the guest job queue, with a
host deadline for promises that never settle). Every cell gets a fresh runtime with a wall-clock
timeout (5 s), a tool-call budget (100, per cell), a 64 MiB heap cap and a 1 MiB stack cap; the
probe asserts `Bun`, `process`, `require` and `module` are not reachable, that cells cannot see
each other's globals, and that guest mutation of a tool result cannot reach the host snapshot.
Stack overflow, heap exhaustion, runaway tool loops and awaited rejections are all pinned to guest
failures rather than host crashes. The broad MCP toolset still runs through the pre-existing
`CodeModeRunner` (`new AsyncFunction`, host realm) — a known limitation of the older runner, not of
the profile path.
