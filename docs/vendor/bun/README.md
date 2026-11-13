# Vendored Bun release notes

Each Bun release this repo audits gets three files here, so an upgrade audit reads a pinned,
machine-checkable change list instead of the live blog.

| File | What it is | Who writes it |
| --- | --- | --- |
| `<version>.md` | The upstream blog post in markdown, byte-for-byte (`https://bun.com/blog/bun-v<version>.md`) | `bun run bun:release fetch <version>` |
| `<version>.changes.yaml` | One entry per change, quoting `<version>.md` verbatim | A person or agent, then `bun run bun:release check <version>` |
| `<version>.digest.md` | Security, breaking and deprecation entries only | `bun run bun:release digest <version>`; never by hand |

`tests/bun_release_vendor.test.ts` fails when a quote is not a verbatim substring of the doc, a
`section` is not one of its headings, a cited commit is not in it, the doc's sha256 moved, or the
digest is stale. `bunfig.toml` keeps `bun fmt` away from this directory so the bytes stay pinned.

## Adding a release

1. `bun run bun:release fetch 1.4.5` writes `1.4.5.md` and prints its sha256 and the commits it
   cites.
2. Write `1.4.5.changes.yaml` with the schema below. Upstream does not label breaking changes, so
   read the whole post (look for "used to", "no longer", "now throws", "instead of") and leave
   `source.classification: derived` until a human has reviewed every `kind`.
3. For each entry, set `upstream` only to a commit the doc cites directly after the quoted bullet
   group, and resolve `pr` with `gh api repos/oven-sh/bun/commits/<sha>/pulls`.
4. `bun run bun:release check 1.4.5 && bun run bun:release digest 1.4.5`, then
   `bun test tests/bun_release_vendor.test.ts`.
5. Run the audit in [`AUDIT_PROMPT.md`](AUDIT_PROMPT.md); `bun run bun:release grep 1.4.5` prints
   the surface hits it classifies.

## Manifest schema (`bun-release-changes/1`)

```yaml
schema: bun-release-changes/1
release: { version: 1.4.4, tag: bun-v1.4.4, commit: <40 hex>, published: <ISO 8601> }
source:
  doc: 1.4.4.md
  url: https://bun.com/blog/bun-v1.4.4.md
  fetched: 2026-11-13
  sha256: <64 hex of 1.4.4.md>
  classification: derived | reviewed
  pr_source: github-commit-pulls
grep_exclude: [node_modules/**, docs/vendor/**, ...]   # Bun.Glob patterns, matched on tracked paths
changes:
  - id: BUN144-BRK-001          # BUN<version digits>-<SEC|BRK|DEP|PRF|NEW|FIX>-<3 digits>
    slug: websocket-close-handshake
    kind: breaking              # security | breaking | deprecation | perf | new | fix
    section: "### `WebSocket` waits for the closing handshake"   # exact heading line
    surface: [WebSocket client]
    old: "<verbatim quote>"     # string or list; at least one of old / new
    new: "<verbatim quote>"
    escape_hatch: "<verbatim quote>"   # optional
    grep: ['new WebSocket\(']   # JavaScript regexes, tested line by line
    upstream: <40 hex> | null   # commit the doc cites for this bullet group
    pr: 12345 | null            # resolved from upstream
    advisory: GHSA-… | CVE-… | https://… | null
```

The audit treats an `AFFECTED` entry whose `pr` and `advisory` are both `null` as a blocker for
human review.
