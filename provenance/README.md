# Archive provenance

Every archive that is committed to this repository (`*.zip`, `*.tar.gz`, `*.tgz`) needs a sidecar
here, named after the file:

```
provenance/example.zip.json
```

```json
{
  "version": 1,
  "file": "example.zip",
  "sha256": "<64 hex chars>",
  "bytes": 1234,
  "origin": "who produced it, when, and from which source",
  "license": "SPDX identifier or an explicit redistribution grant",
  "recordedAt": "YYYY-MM-DD"
}
```

Generate it rather than typing it:

```bash
bun run audit:archives --record path/to/archive.zip \
  --origin "vendor upload 2026-10-20, from the vendor portal" \
  --license Apache-2.0
```

`bun run audit:archives` fails when a tracked archive has no sidecar, when the checksum or byte
count does not match the file, or when `origin`/`license` is a placeholder (`unknown`, `tbd`, `n/a`).
A sidecar that says "unknown" is worse than none, because it looks audited.

Untracked archives are reported as a warning and are not gated; that is the normal state for a local
download. `gs-manager-cli.zip` is untracked for exactly this reason: its origin and licence are not
recorded anywhere, so it cannot be committed under this policy and it has not been deleted.
