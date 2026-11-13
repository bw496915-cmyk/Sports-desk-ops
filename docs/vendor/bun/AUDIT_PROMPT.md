# Bun upgrade audit prompt

Copy everything below the rule into an agent, replacing `<version>` (for example `1.4.4`). It
expects the three files from [README.md](README.md); the `DERIVED-<n>` fallback covers a release
whose manifest is not written yet.

For a lighter run, drop steps 4–5 and the `AFFECTED` diffs to get a triage table in one pass.

---

# Task: audit this repo for Bun `<version>` upgrade impact

## Inputs (read in this order)

1. `docs/vendor/bun/<version>.changes.yaml` — machine manifest (authoritative for IDs, surfaces, greps)
2. `docs/vendor/bun/<version>.digest.md` — breaking + security only
3. `docs/vendor/bun/<version>.md` — full doc (only if 1–2 leave a question open)

If only the full doc exists, derive the change list yourself and mark each derived ID
as `DERIVED-<n>` so a human can promote it later.

## Objective

Produce an audit of which Bun `<version>` changes affect THIS repo, with the minimal
diff to stay compatible. Do not edit files yet.

## Steps (in order, stop and report if any step blocks)

1. **Load changes.** List every entry from the manifest whose `kind` is
   `breaking`, `deprecation`, or `security`. Ignore `perf`, `new`, `fix` unless
   the repo explicitly opts in.
2. **Map surfaces → repo.** For each change, run its `grep` patterns across the
   repo (exclude `node_modules`, `dist`, lockfiles, vendored docs).
   `bun run bun:release grep <version> --json` does this over tracked files with the
   manifest's `grep_exclude`.
3. **Classify each change** as one of:
   - `AFFECTED` — greps hit real code that uses the changed behavior
   - `EXPOSED-OK` — API is used but the change is compatible as written
   - `NOT-USED` — no hits
4. **Draft minimal diffs** for `AFFECTED` entries only. Prefer the manifest's
   `escape_hatch` if present. One change per diff hunk; no drive-by reformatting.
5. **Flag gaps.** Note any `AFFECTED` entry with no `pr` or `advisory` link in the
   manifest — those are the ones a human must review before merging.

## Output format (exactly this)

### Summary

- Changes reviewed: N (breaking: X, deprecation: Y, security: Z)
- AFFECTED: N · EXPOSED-OK: N · NOT-USED: N
- Blockers: list change IDs with missing upstream rationale

### AFFECTED

For each, in priority order (security → breaking → deprecation):

**[BUN144-BRK-00N] websocket-close-handshake**

- Files: `src/ws/client.ts:41`, `src/ws/server.ts:88`
- Why: `onclose` asserts `event.code === 1000`; 1.4.4 reports 1005 when
  `close()` is called without a code.
- Diff:

  ```diff
  - if (event.code === 1000) { ... }
  + if (event.code === 1000 || event.code === 1005) { ... }
  ```

- Upstream: commit bfa1209e · PR: #NNNN (or MISSING)
- Test to add: assert close-code handling for both 1000 and 1005.

### EXPOSED-OK

| ID | Surface | Why it's fine |
| --- | --- | --- |

### NOT-USED

(one line: count + list of IDs)

### Open questions for a human

- [ ] BUN144-SEC-000: no advisory link; confirm scope before relying on TLS behavior.

## Constraints

- Cite the change ID in every finding. If you can't cite one, don't report it.
- Never paraphrase behavior changes; quote the old/new fields verbatim.
- Do not touch lockfiles, node_modules, or vendored docs.
- Do not reformat untouched lines.
- If a grep is ambiguous (e.g. `.close(` matches non-WebSocket code), report
  the file and let a human decide — do not auto-classify as AFFECTED.
- Stop after producing the report. Wait for approval before applying diffs.

---

## Why this shape

- **Ordered inputs** keep the agent on the manifest instead of spending its context on the full
  doc when the manifest answers the question.
- **An explicit classification enum** (`AFFECTED` / `EXPOSED-OK` / `NOT-USED`) stops the
  "everything is affected" failure mode that broad greps invite.
- **The `DERIVED-<n>` fallback** keeps the workflow usable before a manifest exists.
- **"Stop before applying"** makes the output a reviewable artifact, which matters for WebSocket
  and SQL semantics.
- **The blocker rule** (no PR or advisory link means a human reviews it) surfaces upstream's
  traceability gap once per release instead of on every run.
