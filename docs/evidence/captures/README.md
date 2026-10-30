# Evidence capture store — LIVE ONLY

This directory is the sanctioned home for **live** capture records: the evidence that can
upgrade a ledger row from tier B to tier A. It is intentionally empty (apart from this file
and `.gitkeep`) until the first live run. Do not commit mock or offline captures here.

- **Mock/offline fixtures stay under `tests/fixtures/captures/`** (owned by the capture
  tooling). Mock records can never upgrade an evidence tier and `apply_captures` refuses
  them with `E_MODE_NOT_LIVE`.
- **Bodies are never stored.** A record keeps a sha256 plus a schema skeleton, a redaction
  report and provenance. No cookies, tokens, customer IDs, IPs or emails.

## Layout

```
docs/evidence/captures/
  README.md                        # this file
  .gitkeep                         # keeps the empty live store tracked
  manifest.json                    # created by the first live run; indexes captureHash per file
  <YYYY-MM-DD>/
    <slug>.<method>.json           # capture record, schemaVersion 1
  applied-<YYYY-MM-DD>.json        # audit record written only by `apply_captures --write`
```

Record shape (schema v1) and the manifest fields are documented in
[../capture-tooling.md](../capture-tooling.md). `captureHash` in the manifest is the sha256
of the canonical record JSON and is the same value `apply_captures` puts in the ledger
evidence id (`capture:<date>:<sha256>`).

## Producing the first record

Live capture is opt-in and env-gated; credentials come from `.env` and are never passed as
arguments:

```bash
F402_LIVE_CAPTURE=1 \
F402_BASE_URL=… F402_AGENT_ID=… F402_PASSWORD=… \
bun run capture:evidence:live        # writes <date>/<slug>.<method>.json + manifest.json
```

Secrets are read from the environment only. Never put them in argv, a capture file, the
manifest, an audit record, a commit or a log. A live run authenticates as a real agent, so
only the read-only allowlist is captured (see `../capture-tooling.md`).

## Applying captures

```bash
bun run apply:captures               # dry-run: validate the store, print the B→A plan
bun run apply:captures --write       # apply + regenerate spec/markdown + run the docs gate + audit
```

`--write` is capture-ready: it upgrades a B row to A from a valid live capture, regenerates the
spec and markdown, and the docs gate accepts the capture-backed response (`x-capture`). It is
still a real-ledger mutation, so do not run it against the real docs ledger without Lead
approval; tier A stays 0 until the first live run. See
[../capture-tooling.md](../capture-tooling.md) §"Applying captures to this release".

## Never commit here

- mock/offline records (they belong under `tests/fixtures/captures/`);
- raw request/response bodies;
- cookies, tokens, credentials, customer identifiers, IP addresses or emails;
- hand-edited records or a hand-edited `manifest.json` — a mismatch is reported as
  `E_MANIFEST` and refused.
